import test from 'node:test';
import assert from 'node:assert/strict';
import { parseZonarCsvStream } from '../src/zonar-csv-stream.js';

function stream(parts) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    }
  });
}
async function collect(input, options) {
  const items = [];
  for await (const item of parseZonarCsvStream(stream(input), options)) items.push(item);
  return items;
}

test('parses records incrementally across arbitrary chunk boundaries', async () => {
  const items = await collect(['Order Num', 'ber,Ordered Quantity,Order Value\r', '\nO-1,2,"1,250.50"\r', '\nO-2,3,20'], { dataset: 'orders' });
  assert.equal(items[0].type, 'header');
  assert.equal(items[1].record.order_id, 'O-1');
  assert.equal(items[1].record.order_value, 1250.5);
  assert.equal(items[2].record.order_id, 'O-2');
  assert.equal(items.length, 3);
});

test('supports escaped quotes and quoted newlines split across chunks', async () => {
  const items = await collect(['order_id,quantity_ordered,order_value,note\nO-1,1,2,"frag', 'ile ""A""\nbox"'], { dataset: 'orders' });
  assert.equal(items[1].record.order_id, 'O-1');
});

test('rejects malformed rows, invalid numbers and row overflow', async () => {
  await assert.rejects(async () => collect(['order_id,quantity_ordered\nO-1,1,extra'], { dataset: 'orders' }), e => e.code === 'MALFORMED_ROW');
  await assert.rejects(async () => collect(['order_id,quantity_ordered\nO-1,many'], { dataset: 'orders' }), e => e.code === 'INVALID_NUMERIC_VALUE');
  await assert.rejects(async () => collect(['order_id,quantity_ordered\nO-1,1\nO-2,2'], { dataset: 'orders', maxRows: 1 }), e => e.code === 'TOO_MANY_ROWS');
});

test('enforces byte limits on streamed chunks', async () => {
  await assert.rejects(async () => collect(['order_id,quantity_ordered\nO-1,1'], { dataset: 'orders', maxBytes: 10 }), e => e.code === 'UPLOAD_TOO_LARGE');
});
