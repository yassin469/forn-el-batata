-- =====================================================================
-- FORN EL BATATA: DATABASE SETUP
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Run it once. It creates the tables, the security rules and the menu.
-- =====================================================================

-- ---------- 1. TABLES ----------

-- The menu. Edit prices / availability from the admin page.
create table public.menu_items (
  id          text primary key,
  category    text not null,
  name        text not null,
  name_ar     text,
  description text,
  price       integer not null check (price >= 0),
  available   boolean not null default true,
  sort_order  integer not null default 0
);

-- Where you deliver, and how much it costs.
create table public.delivery_areas (
  name       text primary key,
  fee        integer not null check (fee >= 0),
  sort_order integer not null default 0
);

-- Every order a customer places.
create table public.orders (
  id             bigint generated always as identity primary key,
  code           text not null unique default upper(substr(md5(random()::text), 1, 6)),
  created_at     timestamptz not null default now(),
  customer_name  text not null,
  phone          text not null,
  area           text not null references public.delivery_areas(name),
  address        text not null,
  notes          text,
  payment_method text not null check (payment_method in ('cash', 'card')),
  payment_status text not null default 'unpaid'
                 check (payment_status in ('unpaid', 'pending', 'paid', 'failed', 'refunded')),
  status         text not null default 'new'
                 check (status in ('new', 'preparing', 'out_for_delivery', 'delivered', 'cancelled')),
  subtotal       integer not null,
  delivery_fee   integer not null,
  total          integer not null
);

-- The dishes inside each order (price is copied so old orders stay correct if prices change).
create table public.order_items (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references public.orders(id) on delete cascade,
  item_id    text not null references public.menu_items(id),
  name       text not null,
  unit_price integer not null,
  quantity   integer not null check (quantity between 1 and 50)
);
create index on public.order_items(order_id);
create index on public.orders(created_at desc);

-- Who is allowed into the admin page.
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ---------- 2. SECURITY RULES ----------
-- Customers (anonymous visitors) can ONLY read the menu and place orders.
-- Only admins can see orders, change their status and edit the menu.

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

alter table public.menu_items     enable row level security;
alter table public.delivery_areas enable row level security;
alter table public.orders         enable row level security;
alter table public.order_items    enable row level security;
alter table public.admins         enable row level security;

create policy "anyone reads menu"   on public.menu_items     for select using (true);
create policy "admin edits menu"    on public.menu_items     for all    using (public.is_admin()) with check (public.is_admin());
create policy "anyone reads areas"  on public.delivery_areas for select using (true);
create policy "admin edits areas"   on public.delivery_areas for all    using (public.is_admin()) with check (public.is_admin());
create policy "admin reads orders"  on public.orders         for select using (public.is_admin());
create policy "admin updates orders" on public.orders        for update using (public.is_admin()) with check (public.is_admin());
create policy "admin reads items"   on public.order_items    for select using (public.is_admin());
create policy "admin sees self"     on public.admins         for select using (user_id = auth.uid());

-- ---------- 3. PLACING AN ORDER ----------
-- The website calls this. Prices are looked up HERE, in the database,
-- so nobody can change a price in their browser and pay less.

create or replace function public.place_order(
  p_name text, p_phone text, p_area text, p_address text, p_notes text,
  p_payment_method text, p_items jsonb
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_fee   integer;
  v_sub   integer := 0;
  v_count integer := 0;
  v_order public.orders%rowtype;
  v_item  record;
begin
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_phone), '') = '' or coalesce(trim(p_address), '') = '' then
    raise exception 'Please fill in your name, phone and address.';
  end if;
  if p_phone !~ '^[0-9 +()-]{7,20}$' then
    raise exception 'Please enter a valid phone number.';
  end if;
  if p_payment_method not in ('cash', 'card') then
    raise exception 'Please choose a payment method.';
  end if;
  select fee into v_fee from public.delivery_areas where name = p_area;
  if v_fee is null then
    raise exception 'Sorry, we do not deliver to that area yet.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then
    raise exception 'Your cart is empty.';
  end if;

  insert into public.orders (customer_name, phone, area, address, notes, payment_method, payment_status,
                             subtotal, delivery_fee, total)
  values (left(trim(p_name), 100), left(trim(p_phone), 20), p_area, left(trim(p_address), 500),
          nullif(left(trim(coalesce(p_notes, '')), 500), ''), p_payment_method,
          case when p_payment_method = 'card' then 'pending' else 'unpaid' end,
          0, v_fee, 0)
  returning * into v_order;

  for v_item in
    select m.id, m.name, m.price, (e->>'quantity')::integer as qty
    from jsonb_array_elements(p_items) e
    join public.menu_items m on m.id = e->>'id' and m.available
  loop
    if v_item.qty is null or v_item.qty < 1 or v_item.qty > 50 then
      raise exception 'Please choose between 1 and 50 of each item.';
    end if;
    insert into public.order_items (order_id, item_id, name, unit_price, quantity)
    values (v_order.id, v_item.id, v_item.name, v_item.price, v_item.qty);
    v_sub   := v_sub + v_item.price * v_item.qty;
    v_count := v_count + 1;
  end loop;

  if v_count <> jsonb_array_length(p_items) then
    raise exception 'Some items in your cart are no longer available. Please refresh the page.';
  end if;

  update public.orders set subtotal = v_sub, total = v_sub + v_fee where id = v_order.id;
  return json_build_object('code', v_order.code, 'total', v_sub + v_fee, 'payment_method', p_payment_method);
end;
$$;

revoke all on function public.place_order(text, text, text, text, text, text, jsonb) from public;
grant execute on function public.place_order(text, text, text, text, text, text, jsonb) to anon, authenticated;

-- ---------- 4. LIVE UPDATES FOR THE ADMIN PAGE ----------
alter publication supabase_realtime add table public.orders;

-- ---------- 5. STARTING MENU & DELIVERY AREAS ----------
insert into public.delivery_areas (name, fee, sort_order) values
  ('Zamalek', 20, 1),
  ('Garden City', 30, 2),
  ('Downtown', 30, 3);

insert into public.menu_items (id, category, name, name_ar, description, price, sort_order) values
  ('classic', 'Batata', 'Classic Charcoal Batata', 'بطاطا مشوية',
   'A whole roasted sweet potato, split open hot with a knob of butter and a pinch of cinnamon.', 45, 1),
  ('caramel', 'Batata', 'Caramel & Nuts Batata', 'بطاطا كراميل ومكسرات',
   'Mashed roasted batata topped with salted caramel, toasted hazelnuts and pistachio.', 75, 2),
  ('nutella', 'Batata', 'Nutella Batata', 'بطاطا نوتيلا',
   'Roasted batata filled with warm Nutella and crushed biscuits.', 85, 3),
  ('omali', 'Batata', 'Batata Om Ali', 'بطاطا أم علي',
   'Baked in a clay dish with milk, cream, coconut, raisins and flaky pastry. Served bubbling.', 95, 4),
  ('sahlab', 'Drinks', 'Hot Sahlab', 'سحلب',
   'Thick, warm milk drink with coconut, cinnamon and nuts.', 40, 5),
  ('tea', 'Drinks', 'Mint Tea', 'شاي بالنعناع',
   'Fresh mint, served hot.', 25, 6);

-- =====================================================================
-- AFTER RUNNING THIS: make yourself an admin.
-- 1. Supabase → Authentication → Users → Add user → Create new user
--    (your email + a strong password, tick "Auto Confirm User").
-- 2. Then run this line in a new SQL query, with YOUR email:
--
--    insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
-- =====================================================================
