async function handleZonarProfile(request, env) {
  if (request.method !== 'POST') {
    return zonarJson({ error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  // Read the incoming authorisation header.
  const authorization = request.headers.get('Authorization');
  const token = authorization || '';

  // Check that the Worker has a configured secret.
  if (!env.ZONAR_UPLOAD_TOKEN) {
    return zonarJson({
      error: 'AUTH_CONFIGURATION_MISSING',
      message: 'Zonar upload authentication is not configured on this Worker.'
    }, 503);
  }

  // Check that the request contains a valid Bearer prefix.
  if (!token.startsWith('Bearer ')) {
    return zonarJson({
      error: 'UNAUTHORISED',
      message: 'Authorization header missing or Bearer prefix invalid.',
      diagnostic: {
        authorization_header_present: Boolean(authorization),
        bearer_prefix_present: false
      }
    }, 401);
  }

  // Compare the supplied token with the configured Worker secret.
  const suppliedToken = token.slice(7);
  const configuredToken = env.ZONAR_UPLOAD_TOKEN;

  if (!zonarTokenMatches(suppliedToken, configuredToken)) {
    return zonarJson({
      error: 'UNAUTHORISED',
      message: 'Token comparison failed.',
      diagnostic: {
        authorization_header_present: true,
        bearer_prefix_present: true,
        supplied_token_length: suppliedToken.length,
        configured_token_length: configuredToken.length,
        token_lengths_match: suppliedToken.length === configuredToken.length
      }
    }, 401);
  }

  // Check the uploaded file content type.
  const type = (request.headers.get('Content-Type') || '').toLowerCase();

  if (!type.startsWith('text/csv') && !type.startsWith('text/plain')) {
    return zonarJson({
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Send the CSV as text/csv.'
    }, 415);
  }

  try {
    const reader = request.body?.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let csv = '';
    let bytes = 0;

    // Read the CSV while enforcing the upload size limit.
    if (reader) {
      while (true) {
        const part = await reader.read();

        if (part.done) break;

        bytes += part.value.byteLength;

        if (bytes > ZONAR_MAX_BYTES) {
          await reader.cancel();
          return zonarJson({
            error: 'UPLOAD_TOO_LARGE',
            max_bytes: ZONAR_MAX_BYTES
          }, 413);
        }

        csv += decoder.decode(part.value, { stream: true });
      }

      csv += decoder.decode();
    }

    csv = csv.replace(/^\uFEFF/, '');

    if (!csv.trim()) {
      return zonarJson({ error: 'EMPTY_FILE' }, 400);
    }

    const rows = parseZonarCsv(csv);

    if (rows.length < 2) {
      return zonarJson({ error: 'NO_DATA_ROWS' }, 400);
    }

    const headers = rows[0].map(v => v.trim());

    if (headers.length > 100) {
      return zonarJson({
        error: 'TOO_MANY_COLUMNS',
        max_columns: 100
      }, 413);
    }

    const normal = headers.map(zonarNormaliseHeader);

    const duplicateHeaders = [
      ...new Set(
        normal.filter((v, i) => v && normal.indexOf(v) !== i)
      )
    ];

    const blankHeaders = headers
      .map((v, i) => v ? null : i + 1)
      .filter(Boolean);

    const data = rows.slice(1);

    const malformed = data
      .map((r, i) => r.length === headers.length
        ? null
        : {
            row: i + 2,
            expected: headers.length,
            actual: r.length
          }
      )
      .filter(Boolean);

    // Map recognised CSV headers to standard Zonar fields.
    const mappings = {};

    for (const [field, aliases] of Object.entries(ZONAR_ALIASES)) {
      const index = normal.findIndex(v => aliases.includes(v));
      mappings[field] = index < 0 ? null : headers[index];
    }

    // Return the profile and a small preview.
    return zonarJson({
      success: true,
      profiler_version: '0.1.0',
      filename: (request.headers.get('X-Filename') || 'upload.csv').slice(0, 160),
      profile: {
        row_count: data.length,
        column_count: headers.length,
        headers,
        mappings,
        validation: {
          blank_header_positions: blankHeaders,
          duplicate_headers: duplicateHeaders,
          malformed_row_count: malformed.length,
          malformed_rows_sample: malformed.slice(0, 20),
          status: blankHeaders.length ||
            duplicateHeaders.length ||
            malformed.length
              ? 'review_required'
              : 'passed'
        },
        preview: data.slice(0, 5).map(r =>
          Object.fromEntries(
            headers.map((h, i) => [
              h || 'column_' + (i + 1),
              r[i] ?? ''
            ])
          )
        )
      },
      storage: 'not_stored'
    });

  } catch (error) {
    if (error.message === 'TOO_MANY_ROWS') {
      return zonarJson({
        error: 'TOO_MANY_ROWS',
        max_rows: ZONAR_MAX_ROWS
      }, 413);
    }

    if (error.message === 'UNCLOSED_QUOTE') {
      return zonarJson({
        error: 'INVALID_CSV',
        message: 'A quoted field was not closed.'
      }, 400);
    }

    if (error instanceof TypeError) {
      return zonarJson({
        error: 'INVALID_ENCODING',
        message: 'CSV must be UTF-8.'
      }, 400);
    }

    return zonarJson({ error: 'PROFILE_FAILED' }, 400);
  }
}
