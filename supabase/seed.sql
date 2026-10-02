-- Sample data for a fictional store. Never put real customer data here: this repo is public.
insert into organizations (id, name) values ('demo-jewelry', 'Demo Jewelry Co.')
on conflict (id) do nothing;

insert into events (id, organization_id, source, type, occurred_at, received_at, idempotency_key, payload) values
  ('evt_demo_1', 'demo-jewelry', 'manual', 'product.created', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 'demo-product-ring-14k',
   '{"sku": "RING-14K-01", "title": "14k Gold Band", "metal": "gold", "karat": 14, "weightGrams": 4.2, "priceCents": 69500}'),
  ('evt_demo_2', 'demo-jewelry', 'manual', 'order.created', '2026-10-01T12:00:00Z', '2026-10-01T12:00:01Z', 'demo-order-1001',
   '{"orderId": "1001", "sku": "RING-14K-01", "totalCents": 69500}')
on conflict do nothing;

insert into entities (organization_id, kind, id, attributes, source_event_ids, updated_at) values
  ('demo-jewelry', 'product', 'RING-14K-01',
   '{"sku": "RING-14K-01", "title": "14k Gold Band", "metal": "gold", "karat": 14, "weightGrams": 4.2, "priceCents": 69500}',
   '{evt_demo_1}', '2026-10-01T10:00:00Z'),
  ('demo-jewelry', 'order', '1001', '{"sku": "RING-14K-01", "totalCents": 69500}', '{evt_demo_2}', '2026-10-01T12:00:00Z')
on conflict do nothing;
