-- ============================================================================
-- NEXUSTEKFUSION PRIVATE LIMITED — CUSTOMER MY ACCOUNT PORTAL & SUPABASE
-- COMPLETE, PROJECT-RECONCILED DATABASE MIGRATION (SAFE, ADDITIVE & IDEMPOTENT)
--
-- Compatibility Guarantees:
--   1. Preserves all existing customer records, KRASHIVANTRI mobile tables
--      (public.users, public.farmer_profiles, public.pilot_profiles,
--      public.orders, etc.), public.customers SSoT, and web_platform.* tables.
--   2. Safe with Supabase Auth (`auth.users`) AND NexusTekFusion Customer IDs
--      (`NTF-CUST-000001`), multi-profile OTP login, and Express/Drizzle sync.
--   3. Uses `auth_user_id` (nullable UUID) + `user_uid` (TEXT) + `customer_id`
--      (TEXT) with `ON DELETE SET NULL` so financial/order/3D records are
--      never lost on profile updates or account deletion.
--   4. Aligns every column, unique index, and conflict target used by
--      `src/server/supabase-ecommerce.ts`, `supabase-customers.ts`, and
--      `supabase-projects.ts` (including cart items, addresses, wishlists,
--      reviews, invoices, 3D printing files, PCB, B2B, and support tickets).
--   5. Upgrades canonical backing tables (`store_orders`, `invoices`,
--      `customer_carts`, `wishlists`, `product_reviews`, `notifications`,
--      `printing_orders`) and maintains compatibility VIEWs cleanly.
--   6. Safe to re-run in Supabase SQL Editor or on backend startup.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE SCHEMA IF NOT EXISTS web_platform;

-- ============================================================================
-- 1. UNIVERSAL UPDATED_AT TRIGGER & ADMIN / CUSTOMER MATCHING HELPERS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_ntf_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Verified Staff/Admin Check across public.customer_profiles, web_platform.users & JWT claims
CREATE OR REPLACE FUNCTION public.is_admin(uid UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, web_platform
AS $$
DECLARE
  v_jwt_email TEXT;
  v_jwt_role TEXT;
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN TRUE;
  END IF;

  v_jwt_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_jwt_role := lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', ''));

  IF v_jwt_email IN ('info.nexustekfusion@gmail.com', 'info@nexustekfusion.in') THEN
    RETURN TRUE;
  END IF;

  IF v_jwt_role IN (
    'super_admin', 'admin', 'website_manager', 'product_manager',
    'sales_manager', 'project_manager', 'engineer', 'printing_operator',
    'inventory_manager', 'accounts_manager', 'support_manager', 'support_staff'
  ) THEN
    RETURN TRUE;
  END IF;

  IF uid IS NULL THEN
    RETURN FALSE;
  END IF;

  IF to_regclass('public.customer_profiles') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.customer_profiles cp
      WHERE cp.id = uid
        AND cp.role IN (
          'super_admin', 'admin', 'website_manager', 'product_manager',
          'sales_manager', 'project_manager', 'engineer', 'printing_operator',
          'inventory_manager', 'accounts_manager', 'support_manager', 'support_staff'
        )
        AND COALESCE(cp.is_active, TRUE) = TRUE
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  IF to_regclass('web_platform.users') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM web_platform.users u
      WHERE (u.auth_user_id = uid OR u.uid = uid::text)
        AND u.role IN (
          'super_admin', 'admin', 'website_manager', 'product_manager',
          'sales_manager', 'project_manager', 'engineer', 'printing_operator',
          'inventory_manager', 'accounts_manager', 'support_manager', 'support_staff'
        )
        AND COALESCE(u.is_active, TRUE) = TRUE
        AND COALESCE(u.account_status, 'Active') = 'Active'
        AND u.deleted_at IS NULL
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$$;

-- Keep legacy helper public.is_ntf_admin() aligned with public.is_admin(auth.uid())
CREATE OR REPLACE FUNCTION public.is_ntf_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, web_platform
AS $$
  SELECT public.is_admin(auth.uid());
$$;

-- Customer Ownership Matcher across auth.uid(), user_uid (UUID or NTF-CUST-...),
-- public.customers SSoT, and web_platform.users (enables multi-profile & login/logout persistence)
CREATE OR REPLACE FUNCTION public.is_ntf_customer_matches(
  p_auth_user_id UUID,
  p_user_uid TEXT,
  p_customer_id TEXT DEFAULT ''
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, web_platform
AS $$
DECLARE
  v_auth_uid UUID := auth.uid();
  v_auth_text TEXT;
  v_jwt_email TEXT;
BEGIN
  IF v_auth_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  v_auth_text := v_auth_uid::text;

  IF p_auth_user_id IS NOT NULL AND p_auth_user_id = v_auth_uid THEN
    RETURN TRUE;
  END IF;

  IF coalesce(p_user_uid, '') <> '' AND p_user_uid = v_auth_text THEN
    RETURN TRUE;
  END IF;

  IF coalesce(p_customer_id, '') <> '' AND p_customer_id = v_auth_text THEN
    RETURN TRUE;
  END IF;

  v_jwt_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  IF to_regclass('public.customers') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.customers c
      WHERE c.deleted_at IS NULL
        AND COALESCE(c.account_status, 'Active') = 'Active'
        AND (
          c.auth_user_id = v_auth_uid
          OR (v_jwt_email <> '' AND lower(c.email) = v_jwt_email)
        )
        AND (
          (coalesce(p_customer_id, '') <> '' AND c.customer_id = p_customer_id)
          OR (coalesce(p_user_uid, '') <> '' AND (c.customer_id = p_user_uid OR c.user_uid = p_user_uid))
        )
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  IF to_regclass('web_platform.users') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM web_platform.users u
      WHERE u.deleted_at IS NULL
        AND COALESCE(u.is_active, TRUE) = TRUE
        AND (
          u.auth_user_id = v_auth_uid
          OR u.uid = v_auth_text
          OR (v_jwt_email <> '' AND lower(u.email) = v_jwt_email)
        )
        AND (
          (coalesce(p_user_uid, '') <> '' AND u.uid = p_user_uid)
          OR (coalesce(p_customer_id, '') <> '' AND (u.customer_id = p_customer_id OR u.uid = p_customer_id))
        )
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$$;

-- ============================================================================
-- 2. CUSTOMER PROFILES & CORE USER/CUSTOMER EXTENSIONS
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.customer_profiles') IS NULL THEN
    IF to_regclass('auth.users') IS NOT NULL THEN
      CREATE TABLE public.customer_profiles (
        id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        customer_code TEXT,
        customer_id TEXT NOT NULL DEFAULT '',
        full_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        company_name TEXT NOT NULL DEFAULT '',
        company_or_college TEXT NOT NULL DEFAULT '',
        full_address TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '',
        pin_code TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'customer',
        avatar_url TEXT NOT NULL DEFAULT '',
        account_status TEXT NOT NULL DEFAULT 'Active',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
        email_confirmed_at TIMESTAMPTZ,
        phone_confirmed_at TIMESTAMPTZ,
        notification_preferences JSONB NOT NULL DEFAULT '{"emailUpdates":true,"orderAlerts":true,"quotationAlerts":true,"promotionalEmails":false,"whatsappAlerts":true}'::jsonb,
        password_configured BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    ELSE
      CREATE TABLE public.customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_code TEXT,
        customer_id TEXT NOT NULL DEFAULT '',
        full_name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        company_name TEXT NOT NULL DEFAULT '',
        company_or_college TEXT NOT NULL DEFAULT '',
        full_address TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '',
        pin_code TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'customer',
        avatar_url TEXT NOT NULL DEFAULT '',
        account_status TEXT NOT NULL DEFAULT 'Active',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
        email_confirmed_at TIMESTAMPTZ,
        phone_confirmed_at TIMESTAMPTZ,
        notification_preferences JSONB NOT NULL DEFAULT '{"emailUpdates":true,"orderAlerts":true,"quotationAlerts":true,"promotionalEmails":false,"whatsappAlerts":true}'::jsonb,
        password_configured BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    END IF;
  END IF;
END $$;

ALTER TABLE IF EXISTS public.customer_profiles
  ADD COLUMN IF NOT EXISTS customer_code TEXT,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS company_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS company_or_college TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS full_address TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pin_code TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'Active',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{"emailUpdates":true,"orderAlerts":true,"quotationAlerts":true,"promotionalEmails":false,"whatsappAlerts":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS password_configured BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP INDEX IF EXISTS public.customer_code_unique;
CREATE UNIQUE INDEX IF NOT EXISTS customer_code_unique
  ON public.customer_profiles(customer_code)
  WHERE customer_code IS NOT NULL AND customer_code <> '';

CREATE INDEX IF NOT EXISTS idx_customer_profiles_email_lower
  ON public.customer_profiles(lower(email));

CREATE INDEX IF NOT EXISTS idx_customer_profiles_customer_id
  ON public.customer_profiles(customer_id);

-- Prevent customers from self-escalating role / status / customer_code
CREATE OR REPLACE FUNCTION public.protect_customer_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, web_platform
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.role := 'customer';
    NEW.is_active := TRUE;
    NEW.account_status := 'Active';
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    NEW.role := OLD.role;
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    NEW.is_active := OLD.is_active;
  END IF;
  IF NEW.account_status IS DISTINCT FROM OLD.account_status THEN
    NEW.account_status := OLD.account_status;
  END IF;
  IF OLD.customer_code IS NOT NULL AND OLD.customer_code <> '' AND NEW.customer_code IS DISTINCT FROM OLD.customer_code THEN
    NEW.customer_code := OLD.customer_code;
  END IF;
  IF OLD.customer_id IS NOT NULL AND OLD.customer_id <> '' AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    NEW.customer_id := OLD.customer_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_customer_role_trigger ON public.customer_profiles;
CREATE TRIGGER protect_customer_role_trigger
  BEFORE INSERT OR UPDATE ON public.customer_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_customer_role();

-- Auto-create / sync customer_profiles when an auth.users record is created (via Email OTP or OAuth)
CREATE OR REPLACE FUNCTION public.handle_new_customer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_code TEXT;
  v_full_name TEXT;
  v_phone TEXT;
  v_company TEXT;
BEGIN
  IF to_regclass('public.customers') IS NOT NULL THEN
    SELECT c.customer_id INTO v_existing_code
    FROM public.customers c
    WHERE c.deleted_at IS NULL
      AND (c.auth_user_id = NEW.id OR (NEW.email IS NOT NULL AND lower(c.email) = lower(NEW.email)))
    ORDER BY c.created_at ASC
    LIMIT 1;
  END IF;

  v_full_name := COALESCE(NULLIF(trim(NEW.raw_user_meta_data ->> 'full_name'), ''), split_part(COALESCE(NEW.email, ''), '@', 1));
  v_phone := COALESCE(NULLIF(trim(NEW.raw_user_meta_data ->> 'phone'), ''), NULLIF(trim(NEW.phone), ''), '');
  v_company := COALESCE(NULLIF(trim(NEW.raw_user_meta_data ->> 'company_name'), ''), NULLIF(trim(NEW.raw_user_meta_data ->> 'company_or_college'), ''), '');

  INSERT INTO public.customer_profiles (
    id,
    customer_code,
    customer_id,
    email,
    full_name,
    phone,
    company_name,
    company_or_college,
    role,
    email_verified,
    email_confirmed_at,
    phone_verified,
    phone_confirmed_at,
    is_active,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NULLIF(COALESCE(v_existing_code, ''), ''),
    COALESCE(v_existing_code, ''),
    COALESCE(NEW.email, ''),
    v_full_name,
    v_phone,
    v_company,
    v_company,
    'customer',
    NEW.email_confirmed_at IS NOT NULL,
    NEW.email_confirmed_at,
    NEW.phone_confirmed_at IS NOT NULL,
    NEW.phone_confirmed_at,
    TRUE,
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = COALESCE(NULLIF(EXCLUDED.email, ''), public.customer_profiles.email),
    customer_code = COALESCE(NULLIF(public.customer_profiles.customer_code, ''), EXCLUDED.customer_code),
    customer_id = COALESCE(NULLIF(public.customer_profiles.customer_id, ''), EXCLUDED.customer_id),
    full_name = COALESCE(NULLIF(public.customer_profiles.full_name, ''), EXCLUDED.full_name),
    phone = COALESCE(NULLIF(public.customer_profiles.phone, ''), EXCLUDED.phone),
    company_name = COALESCE(NULLIF(public.customer_profiles.company_name, ''), EXCLUDED.company_name),
    company_or_college = COALESCE(NULLIF(public.customer_profiles.company_or_college, ''), EXCLUDED.company_or_college),
    email_verified = public.customer_profiles.email_verified OR EXCLUDED.email_verified,
    email_confirmed_at = COALESCE(public.customer_profiles.email_confirmed_at, EXCLUDED.email_confirmed_at),
    phone_verified = public.customer_profiles.phone_verified OR EXCLUDED.phone_verified,
    phone_confirmed_at = COALESCE(public.customer_profiles.phone_confirmed_at, EXCLUDED.phone_confirmed_at),
    updated_at = NOW();

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_customer();
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    NULL;
END $$;

-- Extend web_platform.users, web_platform.customers & public.customers cleanly
ALTER TABLE IF EXISTS web_platform.users
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{"emailUpdates":true,"orderAlerts":true,"quotationAlerts":true,"promotionalEmails":false,"whatsappAlerts":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS password_configured BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS web_platform.customers
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{"emailUpdates":true,"orderAlerts":true,"quotationAlerts":true,"promotionalEmails":false,"whatsappAlerts":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS password_configured BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS public.customers
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{"emailUpdates":true,"orderAlerts":true,"quotationAlerts":true,"promotionalEmails":false,"whatsappAlerts":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS password_configured BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================================
-- 3. CUSTOMER ACTIVITY LOGS (WEB_PLATFORM & PUBLIC MIRROR)
-- ============================================================================

CREATE TABLE IF NOT EXISTS web_platform.customer_activity_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES web_platform.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'account',
  entity_type TEXT NOT NULL DEFAULT 'customer',
  entity_id TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wp_cust_activity_user_id ON web_platform.customer_activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_wp_cust_activity_customer_id ON web_platform.customer_activity_logs(customer_id);

CREATE TABLE IF NOT EXISTS public.customer_activity_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'account',
  entity_type TEXT NOT NULL DEFAULT 'customer',
  entity_id TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.customer_activity_logs
  ADD COLUMN IF NOT EXISTS user_uid TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'account',
  ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS entity_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pub_cust_activity_uid ON public.customer_activity_logs(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_cust_activity_auth_uid ON public.customer_activity_logs(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_pub_cust_activity_cid ON public.customer_activity_logs(customer_id);

-- ============================================================================
-- 4. CUSTOMER ADDRESSES (BILLING & DELIVERY WITH DEFAULT SELECTION)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.customer_addresses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_address_id INTEGER UNIQUE,
  local_address_id INTEGER UNIQUE,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT 'Primary',
  address_type TEXT NOT NULL DEFAULT 'both',
  full_name TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  house_flat TEXT NOT NULL DEFAULT '',
  street_area TEXT NOT NULL DEFAULT '',
  address_line TEXT NOT NULL DEFAULT '',
  landmark TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  pin_code TEXT NOT NULL DEFAULT '',
  pincode TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'India',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.customer_addresses
  ADD COLUMN IF NOT EXISTS source_address_id INTEGER,
  ADD COLUMN IF NOT EXISTS local_address_id INTEGER,
  ADD COLUMN IF NOT EXISTS user_uid TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT 'Primary',
  ADD COLUMN IF NOT EXISTS address_type TEXT NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address_line TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS landmark TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS district TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pincode TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'India',
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_addresses_source_id
  ON public.customer_addresses(source_address_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_addresses_local_id
  ON public.customer_addresses(local_address_id);
CREATE INDEX IF NOT EXISTS idx_pub_cust_addr_uid ON public.customer_addresses(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_cust_addr_auth_uid ON public.customer_addresses(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_pub_cust_addr_cid ON public.customer_addresses(customer_id);

-- ============================================================================
-- 5. PERSISTENT CART (CANONICAL public.customer_carts + public.customer_cart_items)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.customer_carts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_uid TEXT UNIQUE NOT NULL,
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.customer_carts
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_customer_carts_auth_uid ON public.customer_carts(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_customer_carts_cid ON public.customer_carts(customer_id);

CREATE TABLE IF NOT EXISTS public.customer_cart_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cart_id UUID REFERENCES public.customer_carts(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  product_id INTEGER NOT NULL DEFAULT 0,
  product_sku TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  unit_price_inr INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL DEFAULT 1,
  variant TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.customer_cart_items
  ADD COLUMN IF NOT EXISTS cart_id UUID REFERENCES public.customer_carts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS user_uid TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS product_id INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS product_sku TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS product_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS unit_price_inr INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pub_cart_items_cart ON public.customer_cart_items(cart_id);
CREATE INDEX IF NOT EXISTS idx_pub_cart_items_uid ON public.customer_cart_items(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_cart_items_auth_uid ON public.customer_cart_items(auth_user_id);

-- ============================================================================
-- 6. STORE ORDERS, ORDER ITEMS, ORDER TRACKING & INVOICES (ON DELETE SET NULL)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.store_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number TEXT UNIQUE NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  billing_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal_inr INTEGER NOT NULL DEFAULT 0,
  discount_inr INTEGER NOT NULL DEFAULT 0,
  shipping_inr INTEGER NOT NULL DEFAULT 0,
  gst_inr INTEGER NOT NULL DEFAULT 0,
  total_inr INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT NOT NULL DEFAULT '',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  refund_status TEXT NOT NULL DEFAULT 'none',
  order_status TEXT NOT NULL DEFAULT 'Order Placed',
  razorpay_order_id TEXT NOT NULL DEFAULT '',
  razorpay_payment_id TEXT NOT NULL DEFAULT '',
  tracking_courier TEXT NOT NULL DEFAULT '',
  tracking_id TEXT NOT NULL DEFAULT '',
  tracking_url TEXT NOT NULL DEFAULT '',
  dispatch_date TEXT NOT NULL DEFAULT '',
  expected_delivery_date TEXT NOT NULL DEFAULT '',
  status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.store_orders
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS dispatch_date TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS expected_delivery_date TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status_history JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_store_orders_auth_uid ON public.store_orders(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_store_orders_cid ON public.store_orders(customer_id);

CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES public.store_orders(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  product_id INTEGER NOT NULL DEFAULT 0,
  product_sku TEXT NOT NULL DEFAULT '',
  hsn_code TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  variant TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price_inr INTEGER NOT NULL DEFAULT 0,
  gst_percent INTEGER NOT NULL DEFAULT 18,
  line_total_inr INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.order_items
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.store_orders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS product_id INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hsn_code TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_pub_order_items_order ON public.order_items(order_number);
CREATE INDEX IF NOT EXISTS idx_pub_order_items_order_id ON public.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_pub_order_items_uid ON public.order_items(user_uid);

CREATE TABLE IF NOT EXISTS public.order_tracking (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES public.store_orders(id) ON DELETE CASCADE,
  order_number TEXT UNIQUE NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  current_status TEXT NOT NULL DEFAULT 'Order Placed',
  tracking_courier TEXT NOT NULL DEFAULT '',
  courier_name TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  tracking_url TEXT NOT NULL DEFAULT '',
  dispatch_date TEXT NOT NULL DEFAULT '',
  estimated_delivery TEXT NOT NULL DEFAULT '',
  status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.order_tracking
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.store_orders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tracking_courier TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS courier_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_pub_order_tracking_uid ON public.order_tracking(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_order_tracking_auth_uid ON public.order_tracking(auth_user_id);

CREATE TABLE IF NOT EXISTS public.invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_number TEXT UNIQUE NOT NULL,
  order_id UUID REFERENCES public.store_orders(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL DEFAULT '',
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT 'store_order',
  entity_id INTEGER NOT NULL DEFAULT 0,
  doc_type TEXT NOT NULL DEFAULT 'GST Tax Invoice',
  gstin TEXT NOT NULL DEFAULT '',
  amount_inr INTEGER NOT NULL DEFAULT 0,
  gst_inr INTEGER NOT NULL DEFAULT 0,
  pdf_url TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.invoices
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.store_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'store_order',
  ADD COLUMN IF NOT EXISTS entity_id INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gstin TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pdf_url TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_invoices_user_uid ON public.invoices(user_uid);
CREATE INDEX IF NOT EXISTS idx_invoices_auth_uid ON public.invoices(auth_user_id);

-- ============================================================================
-- 7. WISHLISTS, PRODUCT REVIEWS, NOTIFICATIONS & PAYMENTS MIRROR COLUMNS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wishlists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  product_id INTEGER,
  product_sku TEXT NOT NULL DEFAULT '',
  product_slug TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.wishlists
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS product_id INTEGER,
  ADD COLUMN IF NOT EXISTS product_sku TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS product_slug TEXT NOT NULL DEFAULT '';

ALTER TABLE IF EXISTS public.wishlists
  ALTER COLUMN product_sku SET DEFAULT '';

-- Drop old full UNIQUE(user_uid, product_sku) so multiple products with empty SKU never collide
ALTER TABLE IF EXISTS public.wishlists DROP CONSTRAINT IF EXISTS wishlists_user_uid_product_sku_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wishlists_user_product_sku
  ON public.wishlists(user_uid, product_sku)
  WHERE product_sku IS NOT NULL AND product_sku <> '';

-- Non-partial unique index required by PostgREST upsert onConflict: 'user_uid,product_id'
CREATE UNIQUE INDEX IF NOT EXISTS uq_wishlists_user_product_id
  ON public.wishlists(user_uid, product_id);

CREATE INDEX IF NOT EXISTS idx_wishlists_auth_uid ON public.wishlists(auth_user_id);

CREATE TABLE IF NOT EXISTS public.product_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id INTEGER,
  product_sku TEXT NOT NULL DEFAULT '',
  order_id UUID REFERENCES public.store_orders(id) ON DELETE SET NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.product_reviews
  ADD COLUMN IF NOT EXISTS product_id INTEGER,
  ADD COLUMN IF NOT EXISTS product_sku TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.store_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

ALTER TABLE IF EXISTS public.product_reviews
  ALTER COLUMN product_sku SET DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_product_reviews_product_id ON public.product_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_auth_uid ON public.product_reviews(auth_user_id);

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'system',
  type TEXT NOT NULL DEFAULT 'info',
  link TEXT NOT NULL DEFAULT '',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.notifications
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'info';

CREATE INDEX IF NOT EXISTS idx_notifications_user_uid ON public.notifications(user_uid);
CREATE INDEX IF NOT EXISTS idx_notifications_auth_uid ON public.notifications(auth_user_id);

ALTER TABLE IF EXISTS public.razorpay_payments
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '';

ALTER TABLE IF EXISTS public.contact_enquiries
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '';

ALTER TABLE IF EXISTS public.product_enquiries
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '';

-- ============================================================================
-- 8. CUSTOMER ENQUIRIES, ACTIVE PROJECTS, 3D PRINTING, PCB, B2B & SUPPORT
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.customer_enquiries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  enquiry_number TEXT UNIQUE NOT NULL,
  enquiry_source TEXT NOT NULL DEFAULT 'project',
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'Submitted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.customer_enquiries
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

CREATE INDEX IF NOT EXISTS idx_pub_cust_enq_uid ON public.customer_enquiries(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_cust_enq_auth_uid ON public.customer_enquiries(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_pub_cust_enq_cid ON public.customer_enquiries(customer_id);

CREATE TABLE IF NOT EXISTS public.customer_projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_code TEXT UNIQUE NOT NULL,
  enquiry_number TEXT NOT NULL DEFAULT '',
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  assigned_engineer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Project Development Started',
  progress_percent INTEGER NOT NULL DEFAULT 0,
  total_amount_inr INTEGER NOT NULL DEFAULT 0,
  paid_amount_inr INTEGER NOT NULL DEFAULT 0,
  balance_amount_inr INTEGER NOT NULL DEFAULT 0,
  handover_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
  completion_certificate_number TEXT NOT NULL DEFAULT '',
  documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  updates JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.customer_projects
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

CREATE INDEX IF NOT EXISTS idx_pub_cust_proj_uid ON public.customer_projects(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_cust_proj_auth_uid ON public.customer_projects(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_pub_cust_proj_cid ON public.customer_projects(customer_id);

-- 3D Printing Orders & Files (Admins can inspect/download unpaid files; printing gated by payment)
ALTER TABLE IF EXISTS public.printing_orders
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS user_uid TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_pub_printing_orders_auth_uid ON public.printing_orders(auth_user_id);

CREATE TABLE IF NOT EXISTS public.printing_3d_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number TEXT NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  file_format TEXT NOT NULL DEFAULT '',
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_bucket TEXT NOT NULL DEFAULT 'printing-files',
  storage_path TEXT NOT NULL DEFAULT '',
  file_kind TEXT NOT NULL DEFAULT 'original',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.printing_3d_files
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS file_kind TEXT NOT NULL DEFAULT 'original';

-- Replace single-column UNIQUE(order_number) with composite UNIQUE(order_number, storage_path)
ALTER TABLE IF EXISTS public.printing_3d_files
  DROP CONSTRAINT IF EXISTS printing_3d_files_order_number_key;
DROP INDEX IF EXISTS public.printing_3d_files_order_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_printing_3d_files_order_path
  ON public.printing_3d_files(order_number, storage_path);
CREATE INDEX IF NOT EXISTS idx_printing_3d_files_uid ON public.printing_3d_files(user_uid);
CREATE INDEX IF NOT EXISTS idx_printing_3d_files_auth_uid ON public.printing_3d_files(auth_user_id);

-- PCB Enquiries & Gerber/BOM Files
CREATE TABLE IF NOT EXISTS public.pcb_enquiries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  enquiry_number TEXT UNIQUE NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  board_dimensions_mm TEXT NOT NULL DEFAULT '',
  layer_count INTEGER NOT NULL DEFAULT 2,
  board_quantity INTEGER NOT NULL DEFAULT 5,
  assembly_required BOOLEAN NOT NULL DEFAULT FALSE,
  surface_finish TEXT NOT NULL DEFAULT 'HASL Lead-Free',
  special_instructions TEXT NOT NULL DEFAULT '',
  quoted_amount_inr INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'Submitted',
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.pcb_enquiries
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

CREATE INDEX IF NOT EXISTS idx_pub_pcb_uid ON public.pcb_enquiries(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_pcb_auth_uid ON public.pcb_enquiries(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_pub_pcb_cid ON public.pcb_enquiries(customer_id);

CREATE TABLE IF NOT EXISTS public.pcb_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  enquiry_id UUID REFERENCES public.pcb_enquiries(id) ON DELETE CASCADE,
  enquiry_number TEXT NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  file_kind TEXT NOT NULL DEFAULT 'gerber_or_bom',
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_bucket TEXT NOT NULL DEFAULT 'pcb-files',
  storage_path TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.pcb_files
  ADD COLUMN IF NOT EXISTS enquiry_id UUID REFERENCES public.pcb_enquiries(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS size_bytes INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pub_pcb_files_enq ON public.pcb_files(enquiry_number);
CREATE INDEX IF NOT EXISTS idx_pub_pcb_files_auth_uid ON public.pcb_files(auth_user_id);

-- B2B Enquiries
CREATE TABLE IF NOT EXISTS public.b2b_enquiries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  enquiry_number TEXT UNIQUE NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL DEFAULT '',
  contact_person TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  requirement_category TEXT NOT NULL DEFAULT 'Bulk Hardware',
  quantity INTEGER NOT NULL DEFAULT 10,
  technical_specs TEXT NOT NULL DEFAULT '',
  expected_delivery_date TEXT NOT NULL DEFAULT '',
  shipping_location TEXT NOT NULL DEFAULT '',
  quoted_amount_inr INTEGER,
  volume_discount_percent INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'Submitted',
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.b2b_enquiries
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

CREATE INDEX IF NOT EXISTS idx_pub_b2b_uid ON public.b2b_enquiries(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_b2b_auth_uid ON public.b2b_enquiries(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_pub_b2b_cid ON public.b2b_enquiries(customer_id);

-- Support Tickets & Messages
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_number TEXT UNIQUE NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  service_category TEXT NOT NULL DEFAULT 'General',
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  priority TEXT NOT NULL DEFAULT 'Normal',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.support_tickets
  ADD COLUMN IF NOT EXISTS auth_user_id UUID;

CREATE INDEX IF NOT EXISTS idx_pub_support_uid ON public.support_tickets(user_uid);
CREATE INDEX IF NOT EXISTS idx_pub_support_auth_uid ON public.support_tickets(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_pub_support_cid ON public.support_tickets(customer_id);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  ticket_number TEXT NOT NULL,
  user_uid TEXT NOT NULL DEFAULT '',
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  sender_role TEXT NOT NULL DEFAULT 'customer',
  message_text TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE IF EXISTS public.support_messages
  ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS auth_user_id UUID,
  ADD COLUMN IF NOT EXISTS customer_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS message_text TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT '';

ALTER TABLE IF EXISTS public.support_messages
  ALTER COLUMN message SET DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_pub_support_msg_ticket ON public.support_messages(ticket_number);
CREATE INDEX IF NOT EXISTS idx_pub_support_msg_auth_uid ON public.support_messages(auth_user_id);

-- ============================================================================
-- 9. SAFE COMPATIBILITY VIEWS (NEVER OVERWRITE REAL BASE TABLES)
-- ============================================================================

DO $$
DECLARE
  v_pair TEXT[];
  v_pairs TEXT[][] := ARRAY[
    ARRAY['customer_orders', 'store_orders'],
    ARRAY['customer_invoices', 'invoices'],
    ARRAY['customer_cart', 'customer_carts'],
    ARRAY['customer_wishlist', 'wishlists'],
    ARRAY['customer_reviews', 'product_reviews'],
    ARRAY['customer_notifications', 'notifications'],
    ARRAY['printing_3d_enquiries', 'printing_orders']
  ];
  v_view_name TEXT;
  v_base_name TEXT;
  v_relkind CHAR;
BEGIN
  FOREACH v_pair SLICE 1 IN ARRAY v_pairs LOOP
    v_view_name := v_pair[1];
    v_base_name := v_pair[2];

    IF to_regclass('public.' || v_base_name) IS NOT NULL THEN
      SELECT c.relkind INTO v_relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_view_name
      LIMIT 1;

      -- Only create/replace alias view if name is missing or already a view (never touch a real table)
      IF v_relkind IS NULL OR v_relkind = 'v' THEN
        EXECUTE format(
          'CREATE OR REPLACE VIEW public.%I WITH (security_invoker = true) AS SELECT * FROM public.%I;',
          v_view_name, v_base_name
        );
      END IF;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 10. AUTOMATIC UPDATED_AT TRIGGERS (BASE TABLES ONLY)
-- ============================================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'customer_profiles',
    'customer_carts',
    'customer_addresses',
    'store_orders',
    'order_tracking',
    'customer_cart_items',
    'customer_enquiries',
    'customer_projects',
    'pcb_enquiries',
    'b2b_enquiries',
    'support_tickets'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl AND table_type = 'BASE TABLE'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON public.%I;', tbl, tbl);
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_ntf_set_updated_at();',
        tbl, tbl
      );
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 11. ROW LEVEL SECURITY (CUSTOMER SELF + NTF-CUST PROFILES + VERIFIED ADMIN)
-- ============================================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'customer_profiles',
    'customer_carts',
    'customer_cart_items',
    'customer_addresses',
    'store_orders',
    'order_items',
    'order_tracking',
    'invoices',
    'wishlists',
    'product_reviews',
    'notifications',
    'customer_enquiries',
    'customer_projects',
    'printing_3d_files',
    'pcb_enquiries',
    'pcb_files',
    'b2b_enquiries',
    'support_tickets',
    'support_messages',
    'customer_activity_logs'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl AND table_type = 'BASE TABLE'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
    END IF;
  END LOOP;
END $$;

-- Customer Profiles
DROP POLICY IF EXISTS "Customer manage own profile" ON public.customer_profiles;
CREATE POLICY "Customer manage own profile"
  ON public.customer_profiles FOR ALL
  USING (auth.uid() = id OR public.is_admin(auth.uid()))
  WITH CHECK (auth.uid() = id OR public.is_admin(auth.uid()));

-- Customer Carts & Cart Items
DROP POLICY IF EXISTS "Customer manage own cart" ON public.customer_carts;
CREATE POLICY "Customer manage own cart"
  ON public.customer_carts FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer manage own cart items" ON public.customer_cart_items;
CREATE POLICY "Customer manage own cart items"
  ON public.customer_cart_items FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- Customer Addresses
DROP POLICY IF EXISTS "Customer manage own addresses" ON public.customer_addresses;
CREATE POLICY "Customer manage own addresses"
  ON public.customer_addresses FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- Store Orders (Strict financial ownership; Customers never delete)
DROP POLICY IF EXISTS "Customer read own orders" ON public.store_orders;
CREATE POLICY "Customer read own orders"
  ON public.store_orders FOR SELECT
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer create own orders" ON public.store_orders;
CREATE POLICY "Customer create own orders"
  ON public.store_orders FOR INSERT
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admin manage store orders" ON public.store_orders;
CREATE POLICY "Admin manage store orders"
  ON public.store_orders FOR UPDATE
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Order Items & Order Tracking
DROP POLICY IF EXISTS "Customer read own order items" ON public.order_items;
CREATE POLICY "Customer read own order items"
  ON public.order_items FOR SELECT
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer insert own order items" ON public.order_items;
CREATE POLICY "Customer insert own order items"
  ON public.order_items FOR INSERT
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer read own order tracking" ON public.order_tracking;
CREATE POLICY "Customer read own order tracking"
  ON public.order_tracking FOR SELECT
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admin manage order tracking" ON public.order_tracking;
CREATE POLICY "Admin manage order tracking"
  ON public.order_tracking FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Invoices (Immutable to customers; Admin manages)
DROP POLICY IF EXISTS "Customer read own invoices" ON public.invoices;
CREATE POLICY "Customer read own invoices"
  ON public.invoices FOR SELECT
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admin manage invoices" ON public.invoices;
CREATE POLICY "Admin manage invoices"
  ON public.invoices FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Wishlists
DROP POLICY IF EXISTS "Customer manage own wishlists" ON public.wishlists;
CREATE POLICY "Customer manage own wishlists"
  ON public.wishlists FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- Product Reviews
DROP POLICY IF EXISTS "Public read product reviews" ON public.product_reviews;
CREATE POLICY "Public read product reviews"
  ON public.product_reviews FOR SELECT
  USING (TRUE);

DROP POLICY IF EXISTS "Customer insert own reviews" ON public.product_reviews;
CREATE POLICY "Customer insert own reviews"
  ON public.product_reviews FOR INSERT
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer update own reviews" ON public.product_reviews;
CREATE POLICY "Customer update own reviews"
  ON public.product_reviews FOR UPDATE
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- Notifications
DROP POLICY IF EXISTS "Customer manage own notifications" ON public.notifications;
CREATE POLICY "Customer manage own notifications"
  ON public.notifications FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- Customer Enquiries & Projects
DROP POLICY IF EXISTS "Customer read own enquiries" ON public.customer_enquiries;
CREATE POLICY "Customer read own enquiries"
  ON public.customer_enquiries FOR SELECT
  USING (
    public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id)
    OR (coalesce(email, '') <> '' AND lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
    OR public.is_admin(auth.uid())
  );

DROP POLICY IF EXISTS "Customer create own enquiries" ON public.customer_enquiries;
CREATE POLICY "Customer create own enquiries"
  ON public.customer_enquiries FOR INSERT
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer read own projects" ON public.customer_projects;
CREATE POLICY "Customer read own projects"
  ON public.customer_projects FOR SELECT
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- 3D Printing Enquiries & Files (Admins access & download unpaid files; customers cannot delete)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'printing_orders' AND table_type = 'BASE TABLE'
  ) THEN
    EXECUTE 'ALTER TABLE public.printing_orders ENABLE ROW LEVEL SECURITY;';
    EXECUTE 'DROP POLICY IF EXISTS "Customer read create own 3d printing" ON public.printing_orders;';
    EXECUTE 'CREATE POLICY "Customer read create own 3d printing" ON public.printing_orders FOR SELECT USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR (coalesce(email, '''') <> '''' AND lower(email) = lower(coalesce(auth.jwt() ->> ''email'', ''''))) OR public.is_admin(auth.uid()));';
    EXECUTE 'DROP POLICY IF EXISTS "Customer insert own 3d printing" ON public.printing_orders;';
    EXECUTE 'CREATE POLICY "Customer insert own 3d printing" ON public.printing_orders FOR INSERT WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));';
    EXECUTE 'DROP POLICY IF EXISTS "Admin manage all 3d printing" ON public.printing_orders;';
    EXECUTE 'CREATE POLICY "Admin manage all 3d printing" ON public.printing_orders FOR ALL USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));';
  END IF;
END $$;

DROP POLICY IF EXISTS "Customer read own 3d files" ON public.printing_3d_files;
CREATE POLICY "Customer read own 3d files"
  ON public.printing_3d_files FOR SELECT
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer upload own 3d files" ON public.printing_3d_files;
CREATE POLICY "Customer upload own 3d files"
  ON public.printing_3d_files FOR INSERT
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Admin manage 3d files" ON public.printing_3d_files;
CREATE POLICY "Admin manage 3d files"
  ON public.printing_3d_files FOR ALL
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- PCB Enquiries & Files
DROP POLICY IF EXISTS "Customer manage own pcb enquiries" ON public.pcb_enquiries;
CREATE POLICY "Customer manage own pcb enquiries"
  ON public.pcb_enquiries FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer read own pcb files" ON public.pcb_files;
CREATE POLICY "Customer read own pcb files"
  ON public.pcb_files FOR SELECT
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer upload own pcb files" ON public.pcb_files;
CREATE POLICY "Customer upload own pcb files"
  ON public.pcb_files FOR INSERT
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- B2B Enquiries
DROP POLICY IF EXISTS "Customer manage own b2b enquiries" ON public.b2b_enquiries;
CREATE POLICY "Customer manage own b2b enquiries"
  ON public.b2b_enquiries FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- Support Tickets & Messages
DROP POLICY IF EXISTS "Customer manage own support tickets" ON public.support_tickets;
CREATE POLICY "Customer manage own support tickets"
  ON public.support_tickets FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer manage own support messages" ON public.support_messages;
CREATE POLICY "Customer manage own support messages"
  ON public.support_messages FOR ALL
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()))
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- Customer Activity Logs (Append-only for customers via backend/auth; Admin reads all)
DROP POLICY IF EXISTS "Customer read own activity logs" ON public.customer_activity_logs;
CREATE POLICY "Customer read own activity logs"
  ON public.customer_activity_logs FOR SELECT
  USING (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "Customer insert own activity logs" ON public.customer_activity_logs;
CREATE POLICY "Customer insert own activity logs"
  ON public.customer_activity_logs FOR INSERT
  WITH CHECK (public.is_ntf_customer_matches(auth_user_id, user_uid, customer_id) OR public.is_admin(auth.uid()));

-- ============================================================================
-- 12. PRIVATE STORAGE BUCKETS & POLICIES (3D, PCB, SUPPORT, PROJECTS, INVOICES)
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES
      ('printing-files', 'printing-files', FALSE),
      ('project-files', 'project-files', FALSE),
      ('pcb-files', 'pcb-files', FALSE),
      ('support-files', 'support-files', FALSE),
      ('invoices-pdf', 'invoices-pdf', FALSE),
      ('customer-3d-files', 'customer-3d-files', FALSE),
      ('customer-pcb-files', 'customer-pcb-files', FALSE),
      ('customer-invoices', 'customer-invoices', FALSE),
      ('customer-project-files', 'customer-project-files', FALSE)
    ON CONFLICT (id) DO UPDATE SET public = FALSE;
  END IF;

  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Admin full access portal storage" ON storage.objects;
    CREATE POLICY "Admin full access portal storage"
      ON storage.objects FOR ALL
      USING (
        bucket_id IN (
          'printing-files', 'project-files', 'pcb-files', 'support-files', 'invoices-pdf',
          'customer-3d-files', 'customer-pcb-files', 'customer-invoices', 'customer-project-files'
        )
        AND public.is_admin(auth.uid())
      )
      WITH CHECK (
        bucket_id IN (
          'printing-files', 'project-files', 'pcb-files', 'support-files', 'invoices-pdf',
          'customer-3d-files', 'customer-pcb-files', 'customer-invoices', 'customer-project-files'
        )
        AND public.is_admin(auth.uid())
      );

    -- Customers can upload/read files in their own folder without payment gating
    DROP POLICY IF EXISTS "Customers upload own portal files" ON storage.objects;
    CREATE POLICY "Customers upload own portal files"
      ON storage.objects FOR INSERT
      WITH CHECK (
        bucket_id IN (
          'printing-files', 'project-files', 'pcb-files', 'support-files',
          'customer-3d-files', 'customer-pcb-files', 'customer-project-files'
        )
        AND auth.uid() IS NOT NULL
        AND (
          (storage.foldername(name))[1] = auth.uid()::text
          OR (storage.foldername(name))[1] = 'original'
        )
      );

    DROP POLICY IF EXISTS "Customers read own portal files" ON storage.objects;
    CREATE POLICY "Customers read own portal files"
      ON storage.objects FOR SELECT
      USING (
        bucket_id IN (
          'printing-files', 'project-files', 'pcb-files', 'support-files', 'invoices-pdf',
          'customer-3d-files', 'customer-pcb-files', 'customer-invoices', 'customer-project-files'
        )
        AND (
          (storage.foldername(name))[1] = auth.uid()::text
          OR public.is_admin(auth.uid())
        )
      );
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_table THEN
    NULL;
END $$;

-- ============================================================================
-- 13. PERMISSIONS & POSTGREST SCHEMA RELOAD
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;';
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END $$;

NOTIFY pgrst, 'reload schema';
