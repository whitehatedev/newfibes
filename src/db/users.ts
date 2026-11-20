import crypto from 'crypto';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { createPool, db } from './index.ts';
import {
  adminSessions,
  customerAddresses,
  customers,
  staffPermissions,
  users,
} from './schema.ts';
import { ensureCustomerManagementSchema } from './ensure-customer-mgmt.ts';
import { hashPassword, verifyPassword } from '../server/utils.ts';
import {
  createAnonServerSupabaseClient,
  getServiceRoleSupabaseClient,
} from '../lib/supabase-admin.ts';
import {
  createPublicCustomerRecord,
  findPublicCustomerByKey,
  findPublicCustomerForUser,
  generateNextCustomerCodeFromDb,
  isPublicCustomersSchemaReady,
  listAllPublicCustomersForAuth,
  PublicCustomerRecord,
  recordCustomerIdHistory,
  syncLocalWebUserFromPublicCustomer,
  updatePublicCustomerRecord,
} from '../server/supabase-customers.ts';

const DEFAULT_ADMIN_EMAILS = ['info.nexustekfusion@gmail.com', 'info@nexustekfusion.in'];

export const ADMIN_ROLES_SET = new Set([
  'super_admin',
  'admin',
  'website_manager',
  'product_manager',
  'sales_manager',
  'project_manager',
  'engineer',
  'printing_operator',
  'inventory_manager',
  'accounts_manager',
  'support_manager',
  'support_staff',
]);

export class AuthActionError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AuthActionError';
    this.statusCode = statusCode;
  }
}

export function isUuid(value?: string | null): boolean {
  return Boolean(
    value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
  );
}

export function normalizeEmail(email?: string | null): string {
  return String(email || '').trim().toLowerCase();
}

export function normalizeMobile(mobile?: string | null): string {
  let cleaned = String(mobile || '').trim().replace(/[\s()-]+/g, '');
  if (/^\+91[6-9]\d{9}$/.test(cleaned)) {
    cleaned = cleaned.slice(3);
  } else if (/^91[6-9]\d{9}$/.test(cleaned)) {
    cleaned = cleaned.slice(2);
  }
  return cleaned;
}

const FALLBACK_SESSION_SECRET = crypto
  .createHash('sha256')
  .update(
    `ntf-session-v1-${
      process.env.DATABASE_URL ||
      process.env.SUPABASE_URL ||
      process.env.SQL_HOST ||
      'nexustekfusion-local'
    }`
  )
  .digest('hex');

function getSessionSecret(): string {
  return (
    process.env.ADMIN_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    FALLBACK_SESSION_SECRET
  );
}

function signSessionToken(rawToken: string): string {
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(rawToken)
    .digest('hex');
  return `${rawToken}.${sig}`;
}

function verifySignedSessionToken(signed: string): string | null {
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [rawToken, providedSig] = parts;
  if (!rawToken || !providedSig) return null;
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(rawToken)
    .digest('hex');
  try {
    const a = Buffer.from(providedSig, 'hex');
    const b = Buffer.from(expectedSig, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return rawToken;
  } catch {
    return null;
  }
}

export function isBootstrapAdminEmail(email: string): boolean {
  const configured = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const envInitial = (process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  if (envInitial) configured.push(envInitial);
  const allAdmins = new Set([...DEFAULT_ADMIN_EMAILS, ...configured]);
  return allAdmins.has(email.trim().toLowerCase());
}

export async function ensureInitialAdminUser(): Promise<void> {
  const email = (process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || '';
  const name = (process.env.INITIAL_ADMIN_NAME || 'Super Admin').trim();

  if (!email || !password) return;

  try {
    const existing = await db
      .select()
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = ${email}`,
          isNull(users.deletedAt),
          inArray(users.role, Array.from(ADMIN_ROLES_SET))
        )
      )
      .limit(1);

    if (existing.length > 0) {
      const current = existing[0];
      if (!current.passwordHash && !current.authUserId) {
        const serviceClient = getServiceRoleSupabaseClient();
        if (serviceClient) {
          const { data: created } = await serviceClient.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { full_name: current.fullName || name },
          });
          if (created?.user?.id) {
            await db
              .update(users)
              .set({
                authUserId: created.user.id,
                fullName: current.fullName || name,
                isActive: true,
                accountStatus: 'Active',
                emailVerified: true,
                emailConfirmedAt: created.user.email_confirmed_at || new Date().toISOString(),
                updatedAt: new Date(),
              })
              .where(eq(users.id, current.id));
            return;
          }
        }
        await db
          .update(users)
          .set({
            fullName: current.fullName || name,
            passwordHash: hashPassword(password),
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(users.id, current.id));
      }
      return;
    }

    const serviceClient = getServiceRoleSupabaseClient();
    if (serviceClient) {
      const { data: created } = await serviceClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (created?.user?.id) {
        await db
          .insert(users)
          .values({
            uid: created.user.id,
            authUserId: created.user.id,
            email,
            fullName: name,
            role: 'super_admin',
            passwordHash: null,
            emailVerified: true,
            emailConfirmedAt: created.user.email_confirmed_at || new Date().toISOString(),
            accountStatus: 'Active',
            isActive: true,
          })
          .onConflictDoUpdate({
            target: users.uid,
            set: {
              authUserId: created.user.id,
              role: 'super_admin',
              fullName: name,
              accountStatus: 'Active',
              isActive: true,
              updatedAt: new Date(),
            },
          });
        return;
      }
    }

    await db.insert(users).values({
      uid: `admin_${crypto.randomBytes(6).toString('hex')}`,
      email,
      fullName: name,
      role: 'super_admin',
      passwordHash: hashPassword(password),
      isActive: true,
    });
  } catch (error) {
    console.error('Failed to ensure initial admin user:', error);
  }
}

export async function getAdminSetupStatus() {
  const activeAdmins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isActive, true), isNull(users.deletedAt), sql`${users.role} <> 'customer'`));
  const hasPasswordAdmin = activeAdmins.length > 0;
  const envConfigured = Boolean(process.env.INITIAL_ADMIN_EMAIL && process.env.INITIAL_ADMIN_PASSWORD);
  return {
    configured: hasPasswordAdmin || envConfigured,
    hasPasswordAdmin,
    envConfigured,
  };
}

async function migrateLegacyUserToSupabaseAuth(
  user: typeof users.$inferSelect,
  plainPassword: string
): Promise<typeof users.$inferSelect> {
  if (!ADMIN_ROLES_SET.has(user.role)) return user;
  if (user.authUserId) return user;
  const serviceClient = getServiceRoleSupabaseClient();
  if (!serviceClient) return user;

  try {
    const cleanEmail = normalizeEmail(user.email);
    const { data, error } = await serviceClient.auth.admin.createUser({
      email: cleanEmail,
      password: plainPassword,
      email_confirm: true,
      user_metadata: {
        full_name: user.fullName || '',
        phone: user.mobile || '',
        company_or_college: user.companyOrCollege || '',
      },
    });

    if (error || !data?.user?.id) {
      return user;
    }

    const authId = data.user.id;
    const [updated] = await db
      .update(users)
      .set({
        authUserId: authId,
        passwordHash: null,
        emailVerified: true,
        emailConfirmedAt: user.emailConfirmedAt || data.user.email_confirmed_at || new Date().toISOString(),
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning();

    return updated || user;
  } catch {
    return user;
  }
}

export async function verifyAdminCredentials(email: string, password: string) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail || !password) return null;

  // 1. Try Supabase Auth first if the admin exists in Supabase Auth
  const anonClient = createAnonServerSupabaseClient();
  if (anonClient) {
    const { data, error } = await anonClient.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });
    if (!error && data?.user?.id) {
      const [dbRow] = await db
        .select()
        .from(users)
        .where(
          and(
            isNull(users.deletedAt),
            inArray(users.role, Array.from(ADMIN_ROLES_SET)),
            or(
              eq(users.authUserId, data.user.id),
              eq(users.uid, data.user.id),
              sql`lower(${users.email}) = ${cleanEmail}`
            )
          )
        )
        .limit(1);

      if (dbRow && dbRow.isActive && dbRow.accountStatus === 'Active' && ADMIN_ROLES_SET.has(dbRow.role)) {
        const [updated] = await db
          .update(users)
          .set({ authUserId: data.user.id, lastLoginAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, dbRow.id))
          .returning();
        return updated || dbRow;
      }
      return null;
    }
  }

  // 2. Fallback to legacy pre-migration passwordHash for existing admin accounts ONLY
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        sql`lower(${users.email}) = ${cleanEmail}`,
        isNull(users.deletedAt),
        inArray(users.role, Array.from(ADMIN_ROLES_SET))
      )
    )
    .limit(1);

  const user = rows[0];
  if (!user || !user.isActive || user.accountStatus !== 'Active' || !ADMIN_ROLES_SET.has(user.role)) {
    return null;
  }
  if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    return null;
  }

  return await migrateLegacyUserToSupabaseAuth(user, password);
}

export interface CustomerPermissions {
  canViewCustomers: boolean;
  canAddCustomers: boolean;
  canEditCustomers: boolean;
  canDeactivateCustomers: boolean;
  canReactivateCustomers: boolean;
  canPermanentlyDeleteCustomers: boolean;
  canViewDeletionHistory: boolean;
}

export function getDefaultCustomerPermissions(role: string): CustomerPermissions {
  if (role === 'super_admin') {
    return {
      canViewCustomers: true,
      canAddCustomers: true,
      canEditCustomers: true,
      canDeactivateCustomers: true,
      canReactivateCustomers: true,
      canPermanentlyDeleteCustomers: true,
      canViewDeletionHistory: true,
    };
  }
  if (role === 'admin') {
    return {
      canViewCustomers: true,
      canAddCustomers: true,
      canEditCustomers: true,
      canDeactivateCustomers: true,
      canReactivateCustomers: true,
      canPermanentlyDeleteCustomers: false, // Must be explicitly granted by Super Admin
      canViewDeletionHistory: false,
    };
  }
  if (['sales_manager', 'support_manager', 'support_staff', 'accounts_manager', 'project_manager'].includes(role)) {
    return {
      canViewCustomers: true,
      canAddCustomers: false,
      canEditCustomers: false,
      canDeactivateCustomers: false,
      canReactivateCustomers: false,
      canPermanentlyDeleteCustomers: false,
      canViewDeletionHistory: false,
    };
  }
  return {
    canViewCustomers: false,
    canAddCustomers: false,
    canEditCustomers: false,
    canDeactivateCustomers: false,
    canReactivateCustomers: false,
    canPermanentlyDeleteCustomers: false,
    canViewDeletionHistory: false,
  };
}

export async function getStaffCustomerPermissions(dbUser: {
  id: number;
  role: string;
}): Promise<CustomerPermissions> {
  const defaults = getDefaultCustomerPermissions(dbUser.role);
  if (dbUser.role === 'super_admin') {
    return defaults;
  }
  if (!ADMIN_ROLES_SET.has(dbUser.role)) {
    return getDefaultCustomerPermissions('customer');
  }

  try {
    const [row] = await db
      .select()
      .from(staffPermissions)
      .where(eq(staffPermissions.userId, dbUser.id))
      .limit(1);

    if (!row) return defaults;

    // Security invariant: Employees CANNOT permanently delete customers under any circumstances.
    // Only Admin can permanently delete when explicitly granted by Super Admin.
    const canPermDelete =
      dbUser.role === 'admin' ? Boolean(row.canPermanentlyDeleteCustomers) : false;

    return {
      canViewCustomers: Boolean(row.canViewCustomers),
      canAddCustomers: Boolean(row.canAddCustomers),
      canEditCustomers: Boolean(row.canEditCustomers),
      canDeactivateCustomers: Boolean(row.canDeactivateCustomers),
      canReactivateCustomers: Boolean(row.canReactivateCustomers),
      canPermanentlyDeleteCustomers: canPermDelete,
      canViewDeletionHistory: Boolean(row.canViewDeletionHistory),
    };
  } catch {
    return defaults;
  }
}

export async function setStaffCustomerPermissions(opts: {
  targetUserId: number;
  permissions: Partial<CustomerPermissions>;
  grantedByEmail: string;
}): Promise<CustomerPermissions> {
  const [target] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, opts.targetUserId), isNull(users.deletedAt)))
    .limit(1);

  if (!target || !ADMIN_ROLES_SET.has(target.role)) {
    throw new AuthActionError('Target staff/admin user not found.', 404);
  }
  if (target.role === 'super_admin') {
    throw new AuthActionError('Super Admin permissions are immutable.', 400);
  }

  const current = await getStaffCustomerPermissions(target);
  const next: CustomerPermissions = {
    canViewCustomers: opts.permissions.canViewCustomers ?? current.canViewCustomers,
    canAddCustomers: opts.permissions.canAddCustomers ?? current.canAddCustomers,
    canEditCustomers: opts.permissions.canEditCustomers ?? current.canEditCustomers,
    canDeactivateCustomers: opts.permissions.canDeactivateCustomers ?? current.canDeactivateCustomers,
    canReactivateCustomers: opts.permissions.canReactivateCustomers ?? current.canReactivateCustomers,
    // Employees NEVER get permanent delete under any circumstances
    canPermanentlyDeleteCustomers:
      target.role === 'admin'
        ? Boolean(opts.permissions.canPermanentlyDeleteCustomers ?? current.canPermanentlyDeleteCustomers)
        : false,
    canViewDeletionHistory: opts.permissions.canViewDeletionHistory ?? current.canViewDeletionHistory,
  };

  const now = new Date();
  const [existingRow] = await db
    .select({ id: staffPermissions.id })
    .from(staffPermissions)
    .where(eq(staffPermissions.userId, target.id))
    .limit(1);

  if (existingRow) {
    await db
      .update(staffPermissions)
      .set({
        ...next,
        grantedBy: opts.grantedByEmail,
        updatedAt: now,
      })
      .where(eq(staffPermissions.userId, target.id));
  } else {
    await db.insert(staffPermissions).values({
      userId: target.id,
      ...next,
      grantedBy: opts.grantedByEmail,
      createdAt: now,
      updatedAt: now,
    });
  }

  return next;
}

export async function listStaffWithCustomerPermissions() {
  const staffRows = await db
    .select()
    .from(users)
    .where(and(inArray(users.role, Array.from(ADMIN_ROLES_SET)), isNull(users.deletedAt)));

  const permRows = await db.select().from(staffPermissions).catch(() => []);
  const permByUserId = new Map<number, typeof staffPermissions.$inferSelect>();
  for (const p of permRows) {
    permByUserId.set(p.userId, p);
  }

  return staffRows.map((u) => {
    const defaults = getDefaultCustomerPermissions(u.role);
    const stored = permByUserId.get(u.id);
    const permissions: CustomerPermissions =
      u.role === 'super_admin'
        ? defaults
        : stored
          ? {
              canViewCustomers: Boolean(stored.canViewCustomers),
              canAddCustomers: Boolean(stored.canAddCustomers),
              canEditCustomers: Boolean(stored.canEditCustomers),
              canDeactivateCustomers: Boolean(stored.canDeactivateCustomers),
              canReactivateCustomers: Boolean(stored.canReactivateCustomers),
              canPermanentlyDeleteCustomers:
                u.role === 'admin' ? Boolean(stored.canPermanentlyDeleteCustomers) : false,
              canViewDeletionHistory: Boolean(stored.canViewDeletionHistory),
            }
          : defaults;

    return {
      userId: u.id,
      uid: u.uid,
      email: u.email,
      fullName: u.fullName || u.email,
      role: u.role,
      isActive: u.isActive,
      permissions,
      grantedBy: stored?.grantedBy || '',
      updatedAt: stored?.updatedAt ? new Date(stored.updatedAt).toISOString() : null,
    };
  });
}

export interface CustomerProfileSummary {
  id: string | number;
  customerId: string;
  webUserId: number | null;
  authUserId: string | null;
  fullName: string;
  email: string;
  mobile: string;
  companyOrCollege: string;
  fullAddress: string;
  city: string;
  state: string;
  pinCode: string;
  accountStatus: string;
  registrationDate: string;
  lastLoginAt: string | null;
}

function mapPublicRecordToSummary(r: PublicCustomerRecord): CustomerProfileSummary {
  return {
    id: r.id,
    customerId: r.customerId,
    webUserId: r.webUserId,
    authUserId: r.authUserId,
    fullName: r.fullName,
    email: r.email,
    mobile: r.phoneNumber,
    companyOrCollege: r.companyOrCollege,
    fullAddress: r.fullAddress,
    city: r.city,
    state: r.state,
    pinCode: r.pinCode,
    accountStatus: r.accountStatus || 'Active',
    registrationDate: r.registrationDate,
    lastLoginAt: r.lastLoginAt,
  };
}

function mapLocalCustToSummary(c: typeof customers.$inferSelect): CustomerProfileSummary {
  return {
    id: c.id,
    customerId: c.customerId,
    webUserId: c.userId,
    authUserId: c.authUserId || null,
    fullName: c.fullName,
    email: c.email,
    mobile: c.phoneNumber,
    companyOrCollege: c.companyOrCollege,
    fullAddress: c.fullAddress,
    city: c.city,
    state: c.state,
    pinCode: c.pinCode,
    accountStatus: c.accountStatus || 'Active',
    registrationDate: new Date(c.registrationDate || c.createdAt).toISOString(),
    lastLoginAt: c.lastLoginAt ? new Date(c.lastLoginAt).toISOString() : null,
  };
}

async function ensureLocalUserForCustomerProfile(opts: {
  authUserId: string;
  email: string;
  emailConfirmedAt?: string;
  publicRecord?: PublicCustomerRecord | null;
  localCustomer?: typeof customers.$inferSelect | null;
}): Promise<typeof users.$inferSelect> {
  const cleanEmail = normalizeEmail(opts.email);
  const now = new Date();
  const hasRealPostgres = Boolean(createPool());

  if (opts.publicRecord) {
    const pub = opts.publicRecord;
    await updatePublicCustomerRecord(pub.id, {
      ...(pub.authUserId !== opts.authUserId ? { authUserId: opts.authUserId } : {}),
      emailVerified: true,
      ...(opts.emailConfirmedAt ? { emailConfirmedAt: opts.emailConfirmedAt } : {}),
      lastLoginAt: now,
    }).catch(() => {});

    const synced = await syncLocalWebUserFromPublicCustomer({
      ...pub,
      authUserId: opts.authUserId,
      emailVerified: true,
      lastLoginAt: now.toISOString(),
    });
    if (synced && !ADMIN_ROLES_SET.has(synced.role)) {
      if (hasRealPostgres && pub.webUserId !== synced.id) {
        await updatePublicCustomerRecord(pub.id, { webUserId: synced.id }).catch(() => {});
      }
      return synced;
    }

    // Create isolated web_platform.users row with uid = pub.customerId (never collide with staff row)
    const [uidCollision] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.uid, pub.customerId)).limit(1);
    const safeUid =
      uidCollision && ADMIN_ROLES_SET.has(uidCollision.role)
        ? `${pub.customerId}-${crypto.randomBytes(3).toString('hex')}`
        : pub.customerId;
    const [inserted] = await db
      .insert(users)
      .values({
        uid: safeUid,
        authUserId: opts.authUserId,
        email: cleanEmail,
        fullName: pub.fullName,
        mobile: pub.phoneNumber,
        companyOrCollege: pub.companyOrCollege,
        fullAddress: pub.fullAddress,
        city: pub.city,
        state: pub.state,
        pinCode: pub.pinCode,
        role: 'customer',
        passwordHash: null,
        emailVerified: true,
        emailConfirmedAt: opts.emailConfirmedAt || now.toISOString(),
        accountStatus: 'Active',
        isActive: true,
        lastLoginAt: now,
      })
      .returning();

    if (hasRealPostgres) {
      await updatePublicCustomerRecord(pub.id, { webUserId: inserted.id }).catch(() => {});
    }
    return inserted;
  }

  const lc = opts.localCustomer!;
  if (lc.userId) {
    const [existingUser] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, lc.userId), isNull(users.deletedAt)))
      .limit(1);
    if (existingUser && !ADMIN_ROLES_SET.has(existingUser.role)) {
      const [updated] = await db
        .update(users)
        .set({
          authUserId: opts.authUserId,
          email: cleanEmail,
          emailVerified: true,
          emailConfirmedAt: opts.emailConfirmedAt || existingUser.emailConfirmedAt || now.toISOString(),
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, existingUser.id))
        .returning();
      await db
        .update(customers)
        .set({ authUserId: opts.authUserId, emailVerified: true, lastLoginAt: now, updatedAt: now })
        .where(eq(customers.id, lc.id))
        .catch(() => {});
      return updated || existingUser;
    }
  }

  const [byCode] = await db
    .select()
    .from(users)
    .where(and(eq(users.uid, lc.customerId), isNull(users.deletedAt)))
    .limit(1);
  if (byCode && !ADMIN_ROLES_SET.has(byCode.role)) {
    const [updated] = await db
      .update(users)
      .set({
        authUserId: opts.authUserId,
        emailVerified: true,
        emailConfirmedAt: opts.emailConfirmedAt || byCode.emailConfirmedAt || now.toISOString(),
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, byCode.id))
      .returning();
    await db
      .update(customers)
      .set({ userId: byCode.id, authUserId: opts.authUserId, emailVerified: true, lastLoginAt: now, updatedAt: now })
      .where(eq(customers.id, lc.id))
      .catch(() => {});
    return updated || byCode;
  }

  const [inserted] = await db
    .insert(users)
    .values({
      uid: lc.customerId,
      authUserId: opts.authUserId,
      email: cleanEmail,
      fullName: lc.fullName,
      mobile: lc.phoneNumber,
      companyOrCollege: lc.companyOrCollege,
      fullAddress: lc.fullAddress,
      city: lc.city,
      state: lc.state,
      pinCode: lc.pinCode,
      role: 'customer',
      passwordHash: null,
      emailVerified: true,
      emailConfirmedAt: opts.emailConfirmedAt || now.toISOString(),
      accountStatus: 'Active',
      isActive: true,
      lastLoginAt: now,
    })
    .returning();

  await db
    .update(customers)
    .set({ userId: inserted.id, authUserId: opts.authUserId, emailVerified: true, lastLoginAt: now, updatedAt: now })
    .where(eq(customers.id, lc.id))
    .catch(() => {});

  return inserted;
}

export async function listActiveCustomerProfilesForAuth(opts: {
  authUserId: string;
  email: string;
}): Promise<{
  publicReady: boolean;
  allProfiles: CustomerProfileSummary[];
  activeProfiles: CustomerProfileSummary[];
  inactiveProfiles: CustomerProfileSummary[];
  publicRecordsMap: Map<string, PublicCustomerRecord>;
  localRecordsMap: Map<string, typeof customers.$inferSelect>;
}> {
  const cleanEmail = normalizeEmail(opts.email);
  const publicReady = await isPublicCustomersSchemaReady();
  const publicRecordsMap = new Map<string, PublicCustomerRecord>();
  const localRecordsMap = new Map<string, typeof customers.$inferSelect>();

  let allProfiles: CustomerProfileSummary[] = [];

  if (publicReady) {
    const pubs = await listAllPublicCustomersForAuth({
      authUserId: opts.authUserId,
      email: cleanEmail,
      includeDeleted: false,
    });
    for (const p of pubs) {
      publicRecordsMap.set(p.customerId, p);
    }
    allProfiles = pubs.map(mapPublicRecordToSummary);

    // Also include any local fallback profiles not yet replicated to public.customers
    const conds = [sql`lower(${customers.email}) = ${cleanEmail}`];
    if (isUuid(opts.authUserId)) {
      conds.push(eq(customers.authUserId, opts.authUserId));
    }
    const localRows = await db
      .select()
      .from(customers)
      .where(and(isNull(customers.deletedAt), or(...conds)))
      .catch(() => []);
    for (const lc of localRows) {
      localRecordsMap.set(lc.customerId, lc);
      if (!publicRecordsMap.has(lc.customerId)) {
        allProfiles.push(mapLocalCustToSummary(lc));
      }
    }
  } else {
    const conds = [sql`lower(${customers.email}) = ${cleanEmail}`];
    if (isUuid(opts.authUserId)) {
      conds.push(eq(customers.authUserId, opts.authUserId));
    }
    const localRows = await db
      .select()
      .from(customers)
      .where(and(isNull(customers.deletedAt), or(...conds)));
    for (const lc of localRows) {
      localRecordsMap.set(lc.customerId, lc);
    }
    allProfiles = localRows.map(mapLocalCustToSummary);
  }

  const activeProfiles = allProfiles.filter((p) => p.accountStatus === 'Active');
  const inactiveProfiles = allProfiles.filter((p) => p.accountStatus !== 'Active');

  return {
    publicReady,
    allProfiles,
    activeProfiles,
    inactiveProfiles,
    publicRecordsMap,
    localRecordsMap,
  };
}

export async function resolveCustomerProfilesByVerifiedAuth(opts: {
  authUserId: string;
  email: string;
  emailConfirmedAt?: string;
  customerOnly?: boolean;
}): Promise<
  | {
      kind: 'staff';
      user: typeof users.$inferSelect;
    }
  | {
      kind: 'needs_registration';
      email: string;
      authUserId: string;
    }
  | {
      kind: 'single';
      user: typeof users.$inferSelect;
      activeProfile: CustomerProfileSummary;
      profiles: CustomerProfileSummary[];
    }
  | {
      kind: 'select_profile';
      email: string;
      authUserId: string;
      profiles: CustomerProfileSummary[];
    }
> {
  await ensureCustomerManagementSchema();
  const cleanEmail = normalizeEmail(opts.email);
  const now = new Date();

  const staffConds = [eq(users.authUserId, opts.authUserId), eq(users.uid, opts.authUserId)];
  if (cleanEmail) staffConds.push(sql`lower(${users.email}) = ${cleanEmail}`);
  const matchedStaffRows = await db
    .select()
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        inArray(users.role, Array.from(ADMIN_ROLES_SET)),
        or(...staffConds)
      )
    );
  const staffMatch = matchedStaffRows[0];

  // When resolving via Customer Email OTP (customerOnly: true), NEVER grant Admin/Staff session
  if (!opts.customerOnly && staffMatch) {
    if (!staffMatch.isActive || staffMatch.accountStatus !== 'Active') {
      throw new AuthActionError('Your staff account is currently inactive. Please contact Super Admin.', 403);
    }
    const [updatedStaff] = await db
      .update(users)
      .set({
        authUserId: opts.authUserId,
        emailVerified: true,
        emailConfirmedAt: opts.emailConfirmedAt || staffMatch.emailConfirmedAt || now.toISOString(),
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, staffMatch.id))
      .returning();
    return { kind: 'staff', user: updatedStaff || staffMatch };
  }

  const { allProfiles, activeProfiles, inactiveProfiles, publicRecordsMap, localRecordsMap } =
    await listActiveCustomerProfilesForAuth({ authUserId: opts.authUserId, email: cleanEmail });

  if (allProfiles.length === 0) {
    if (opts.customerOnly && staffMatch) {
      throw new AuthActionError(
        'Administrator accounts must sign in through the separate Admin Login portal (/admin/login).',
        403
      );
    }
    return { kind: 'needs_registration', email: cleanEmail, authUserId: opts.authUserId };
  }

  if (activeProfiles.length === 0) {
    const statusLabel = inactiveProfiles[0]?.accountStatus || 'Deactivated';
    for (const p of inactiveProfiles) {
      if (p.webUserId) {
        await db.delete(adminSessions).where(eq(adminSessions.userId, p.webUserId)).catch(() => {});
      }
    }
    throw new AuthActionError(
      `Your customer account is currently ${statusLabel}. Please contact support.`,
      403
    );
  }

  if (activeProfiles.length === 1) {
    const target = activeProfiles[0];
    const linkedUser = await ensureLocalUserForCustomerProfile({
      authUserId: opts.authUserId,
      email: cleanEmail,
      emailConfirmedAt: opts.emailConfirmedAt,
      publicRecord: publicRecordsMap.get(target.customerId) || null,
      localCustomer: localRecordsMap.get(target.customerId) || null,
    });
    return {
      kind: 'single',
      user: linkedUser,
      activeProfile: { ...target, webUserId: linkedUser.id, authUserId: opts.authUserId },
      profiles: activeProfiles.map((p) =>
        p.customerId === target.customerId ? { ...p, webUserId: linkedUser.id, authUserId: opts.authUserId } : p
      ),
    };
  }

  return {
    kind: 'select_profile',
    email: cleanEmail,
    authUserId: opts.authUserId,
    profiles: activeProfiles,
  };
}

export async function selectCustomerProfileForAuthUser(opts: {
  authUserId: string;
  email: string;
  customerId: string;
  emailConfirmedAt?: string;
}): Promise<{
  user: typeof users.$inferSelect;
  activeProfile: CustomerProfileSummary;
  profiles: CustomerProfileSummary[];
}> {
  await ensureCustomerManagementSchema();
  const cleanEmail = normalizeEmail(opts.email);
  const targetCode = String(opts.customerId || '').trim().toUpperCase();
  if (!targetCode) {
    throw new AuthActionError('Customer profile ID is required.', 400);
  }

  const { activeProfiles, inactiveProfiles, publicRecordsMap, localRecordsMap } =
    await listActiveCustomerProfilesForAuth({ authUserId: opts.authUserId, email: cleanEmail });

  const inactiveMatch = inactiveProfiles.find((p) => p.customerId.toUpperCase() === targetCode);
  if (inactiveMatch) {
    throw new AuthActionError(
      `Profile ${inactiveMatch.customerId} is currently ${inactiveMatch.accountStatus}. Please select an active profile or contact support.`,
      403
    );
  }

  const selected = activeProfiles.find((p) => p.customerId.toUpperCase() === targetCode);
  if (!selected) {
    throw new AuthActionError('Selected customer profile does not belong to your verified email.', 403);
  }

  const linkedUser = await ensureLocalUserForCustomerProfile({
    authUserId: opts.authUserId,
    email: cleanEmail,
    emailConfirmedAt: opts.emailConfirmedAt,
    publicRecord: publicRecordsMap.get(selected.customerId) || null,
    localCustomer: localRecordsMap.get(selected.customerId) || null,
  });

  return {
    user: linkedUser,
    activeProfile: { ...selected, webUserId: linkedUser.id, authUserId: opts.authUserId },
    profiles: activeProfiles.map((p) =>
      p.customerId === selected.customerId ? { ...p, webUserId: linkedUser.id, authUserId: opts.authUserId } : p
    ),
  };
}

export async function completeCustomerRegistrationFromOtp(input: {
  authUserId: string;
  email: string;
  emailConfirmedAt?: string;
  fullName: string;
  mobile: string;
  companyOrCollege?: string;
  fullAddress?: string;
  city?: string;
  state?: string;
  pinCode?: string;
}): Promise<{
  user: typeof users.$inferSelect;
  activeProfile: CustomerProfileSummary;
  profiles: CustomerProfileSummary[];
}> {
  await ensureCustomerManagementSchema();

  const cleanEmail = normalizeEmail(input.email);
  const cleanFullName = String(input.fullName || '').trim();
  const cleanMobile = normalizeMobile(input.mobile);
  const cleanCompany = String(input.companyOrCollege || '').trim();
  const cleanAddress = String(input.fullAddress || '').trim();
  const cleanCity = String(input.city || '').trim();
  const cleanState = String(input.state || '').trim();
  const cleanPinCode = String(input.pinCode || '').trim();

  if (!cleanFullName || cleanFullName.length < 2) {
    throw new AuthActionError('Full Name is required (minimum 2 characters).', 400);
  }
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new AuthActionError('Verified email address is required.', 400);
  }
  if (!cleanMobile || !/^\+?\d{10,15}$/.test(cleanMobile)) {
    throw new AuthActionError('Please enter a valid 10-digit mobile number.', 400);
  }
  if (cleanPinCode && !/^[0-9]{4,10}$/.test(cleanPinCode)) {
    throw new AuthActionError('PIN Code must be 4 to 10 numeric digits.', 400);
  }

  const now = new Date();
  const publicReady = await isPublicCustomersSchemaReady();
  const hasRealPostgres = Boolean(createPool());
  const customerCode = await generateNextCustomerCodeFromDb();

  // Create an isolated web_platform.users row for THIS customer profile (ZERO password created/stored)
  const [linkedUser] = await db
    .insert(users)
    .values({
      uid: customerCode,
      authUserId: input.authUserId,
      email: cleanEmail,
      fullName: cleanFullName,
      mobile: cleanMobile,
      companyOrCollege: cleanCompany,
      fullAddress: cleanAddress,
      city: cleanCity,
      state: cleanState,
      pinCode: cleanPinCode,
      role: 'customer',
      passwordHash: null,
      emailVerified: true,
      phoneVerified: false,
      emailConfirmedAt: input.emailConfirmedAt || now.toISOString(),
      phoneConfirmedAt: '',
      accountStatus: 'Active',
      isActive: true,
      lastLoginAt: now,
    })
    .returning();

  let activeProfile: CustomerProfileSummary;
  try {
    let persistedPublic: PublicCustomerRecord | null = null;
    if (publicReady) {
      try {
        persistedPublic = await createPublicCustomerRecord({
          customerId: customerCode,
          authUserId: input.authUserId,
          userUid: customerCode,
          ...(hasRealPostgres ? { webUserId: linkedUser.id } : {}),
          fullName: cleanFullName,
          email: cleanEmail,
          phoneNumber: cleanMobile,
          companyOrCollege: cleanCompany,
          fullAddress: cleanAddress,
          city: cleanCity,
          state: cleanState,
          pinCode: cleanPinCode,
          accountStatus: 'Active',
          emailVerified: true,
          emailConfirmedAt: input.emailConfirmedAt || now,
          registrationDate: now,
          lastLoginAt: now,
        });
      } catch (pubErr: any) {
        if (/customer_profiles/i.test(String(pubErr?.message || ''))) {
          console.warn(
            'Supabase public.customers insert hit legacy customer_profiles trigger mismatch; falling back to web_platform.customers. Run supabase/public_customers_sync.sql in Supabase SQL Editor to update legacy triggers:',
            pubErr?.message
          );
        } else {
          throw pubErr;
        }
      }
    }

    if (persistedPublic) {
      activeProfile = {
        ...mapPublicRecordToSummary(persistedPublic),
        webUserId: linkedUser.id,
      };
    } else {
      const [insertedCust] = await db
        .insert(customers)
        .values({
          customerId: customerCode,
          userId: linkedUser.id,
          authUserId: input.authUserId,
          fullName: cleanFullName,
          email: cleanEmail,
          phoneNumber: cleanMobile,
          companyOrCollege: cleanCompany,
          fullAddress: cleanAddress,
          city: cleanCity,
          state: cleanState,
          pinCode: cleanPinCode,
          passwordHash: '',
          emailVerified: true,
          accountStatus: 'Active',
          registrationDate: now,
          lastLoginAt: now,
        })
        .returning();
      activeProfile = mapLocalCustToSummary(insertedCust);
    }

    if (cleanAddress || cleanCity || cleanState || cleanPinCode) {
      await db.insert(customerAddresses).values({
        userId: linkedUser.id,
        label: 'Primary',
        addressType: 'both',
        fullName: cleanFullName,
        mobile: cleanMobile,
        houseFlat: cleanAddress || cleanCity || 'Primary Address',
        streetArea: '',
        landmark: '',
        city: cleanCity,
        district: cleanCity,
        state: cleanState,
        pinCode: cleanPinCode,
        country: 'India',
        isDefault: true,
      });
    }

    await recordCustomerIdHistory({
      customerDbId: activeProfile.id,
      authUserId: input.authUserId,
      email: cleanEmail,
      previousCustomerId: null,
      newCustomerId: customerCode,
      newAccountStatus: 'Active',
      operationType: 'otp_registration',
      reason: 'Customer completed profile registration after Email OTP verification',
      changedBy: cleanEmail,
    });
  } catch (err: any) {
    await db.delete(customerAddresses).where(eq(customerAddresses.userId, linkedUser.id)).catch(() => {});
    await db.delete(users).where(eq(users.id, linkedUser.id)).catch(() => {});
    if (err instanceof AuthActionError) throw err;
    throw new AuthActionError(err?.message || 'Failed to create customer profile.', 500);
  }

  const { activeProfiles } = await listActiveCustomerProfilesForAuth({
    authUserId: input.authUserId,
    email: cleanEmail,
  });

  return {
    user: linkedUser,
    activeProfile,
    profiles: activeProfiles.length > 0 ? activeProfiles : [activeProfile],
  };
}

export async function createAdminSession(
  userId: number,
  userAgent = '',
  activeCustomerId = '',
  sessionScope?: 'customer' | 'admin'
) {
  const [userRow] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  if (!userRow || !userRow.isActive || userRow.accountStatus !== 'Active') {
    throw new AuthActionError('Account is inactive or unavailable.', 403);
  }

  const isStaffUser = ADMIN_ROLES_SET.has(userRow.role);
  const resolvedScope: 'customer' | 'admin' =
    sessionScope || (isStaffUser ? 'admin' : 'customer');

  if (resolvedScope === 'admin' && !isStaffUser) {
    throw new AuthActionError(
      'Security check failed: Cannot issue an admin session for a customer account.',
      403
    );
  }
  if (resolvedScope === 'customer' && isStaffUser) {
    throw new AuthActionError(
      'Administrator accounts must sign in through the separate Admin Login portal (/admin/login).',
      403
    );
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(adminSessions).values({
    tokenHash,
    userId,
    activeCustomerId: resolvedScope === 'customer' ? activeCustomerId || '' : '',
    sessionScope: resolvedScope,
    userAgent: userAgent.slice(0, 240),
    expiresAt,
  });

  return {
    cookieValue: signSessionToken(rawToken),
    expiresAt,
    sessionScope: resolvedScope,
  };
}

export async function getSessionContextByToken(
  signedToken: string,
  expectedScope?: 'customer' | 'admin'
): Promise<{
  user: typeof users.$inferSelect;
  activeCustomerId: string;
  sessionScope: 'customer' | 'admin';
} | null> {
  const rawToken = verifySignedSessionToken(signedToken);
  if (!rawToken) return null;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const rows = await db
    .select({
      user: users,
      activeCustomerId: adminSessions.activeCustomerId,
      sessionScope: adminSessions.sessionScope,
    })
    .from(adminSessions)
    .innerJoin(users, eq(adminSessions.userId, users.id))
    .where(
      and(
        eq(adminSessions.tokenHash, tokenHash),
        gt(adminSessions.expiresAt, new Date()),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row?.user || !row.user.isActive || row.user.accountStatus !== 'Active') return null;

  const isStaffUser = ADMIN_ROLES_SET.has(row.user.role);
  const scope: 'customer' | 'admin' =
    row.sessionScope === 'admin' || row.sessionScope === 'customer'
      ? row.sessionScope
      : isStaffUser
      ? 'admin'
      : 'customer';

  // Strict DB role <-> sessionScope verification
  if (scope === 'admin' && !isStaffUser) return null;
  if (scope === 'customer' && isStaffUser) return null;
  if (expectedScope && scope !== expectedScope) return null;

  return {
    user: row.user,
    activeCustomerId:
      scope === 'customer'
        ? row.activeCustomerId || (row.user.uid.startsWith('NTF-CUST-') ? row.user.uid : '')
        : '',
    sessionScope: scope,
  };
}

export async function getUserBySessionToken(signedToken: string) {
  const ctx = await getSessionContextByToken(signedToken);
  return ctx?.user || null;
}

export async function deleteAdminSession(signedToken: string) {
  const rawToken = verifySignedSessionToken(signedToken);
  if (!rawToken) return;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, tokenHash));
}

export async function updateUserPassword(userId: number, newPassword: string) {
  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow) throw new AuthActionError('User not found.', 404);

  const now = new Date();
  const isStaff = ADMIN_ROLES_SET.has(userRow.role);
  const serviceClient = getServiceRoleSupabaseClient();

  if (!isStaff) {
    // Customer profiles can share one email while holding independent Customer IDs;
    // always store profile-scoped passwordHash + passwordConfigured.
    const hashed = hashPassword(newPassword);
    await db
      .update(users)
      .set({
        passwordHash: hashed,
        passwordConfigured: true,
        updatedAt: now,
      })
      .where(eq(users.id, userId));

    await db
      .update(customers)
      .set({
        passwordHash: hashed,
        passwordConfigured: true,
        lastPasswordChangeAt: now,
        lastPasswordResetAt: now,
        passwordResetStatus: 'Active',
        updatedAt: now,
      })
      .where(eq(customers.userId, userId))
      .catch(() => {});

    return;
  }

  if (serviceClient) {
    let targetAuthId = userRow.authUserId || (isUuid(userRow.uid) ? userRow.uid : null);
    if (targetAuthId) {
      const { error } = await serviceClient.auth.admin.updateUserById(targetAuthId, {
        password: newPassword,
      });
      if (error) {
        throw new AuthActionError(error.message || 'Failed to update password in Supabase Auth.', 400);
      }
    } else {
      const { data: created, error } = await serviceClient.auth.admin.createUser({
        email: normalizeEmail(userRow.email),
        password: newPassword,
        email_confirm: true,
        user_metadata: {
          full_name: userRow.fullName || '',
          phone: userRow.mobile || '',
          company_or_college: userRow.companyOrCollege || '',
        },
      });
      if (error || !created?.user?.id) {
        throw new AuthActionError(error?.message || 'Failed to sync password with Supabase Auth.', 400);
      }
      targetAuthId = created.user.id;
    }

    await db
      .update(users)
      .set({
        authUserId: targetAuthId,
        passwordHash: null,
        passwordConfigured: true,
        updatedAt: now,
      })
      .where(eq(users.id, userId));
    return;
  }

  await db
    .update(users)
    .set({
      passwordHash: hashPassword(newPassword),
      passwordConfigured: true,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
}

export async function resolveCustomerForCustomerIdAuth(rawCustomerId: string): Promise<{
  user: typeof users.$inferSelect;
  activeProfile: CustomerProfileSummary;
  profiles: CustomerProfileSummary[];
  hasPassword: boolean;
}> {
  await ensureCustomerManagementSchema();
  const code = String(rawCustomerId || '').trim().toUpperCase();
  if (!/^NTF-CUST-\d{3,}$/i.test(code)) {
    throw new AuthActionError('Please enter a valid Customer ID (e.g. NTF-CUST-000001).', 400);
  }

  const publicReady = await isPublicCustomersSchemaReady();
  const publicMatch = publicReady ? await findPublicCustomerByKey(code) : null;
  const [localMatch] = await db
    .select()
    .from(customers)
    .where(and(sql`upper(${customers.customerId}) = ${code}`, isNull(customers.deletedAt)))
    .limit(1);

  if (!publicMatch && !localMatch) {
    // Also check if an unlinked customer users row exists by uid
    const [uidUser] = await db
      .select()
      .from(users)
      .where(and(sql`upper(${users.uid}) = ${code}`, isNull(users.deletedAt)))
      .limit(1);
    if (!uidUser) {
      throw new AuthActionError(`No customer account found with Customer ID ${code}.`, 404);
    }
    if (ADMIN_ROLES_SET.has(uidUser.role)) {
      throw new AuthActionError(
        'Administrator accounts must sign in through the separate Admin Login portal (/admin/login).',
        403
      );
    }
    if (!uidUser.isActive || uidUser.accountStatus !== 'Active') {
      throw new AuthActionError(
        `Customer account ${code} is currently ${uidUser.accountStatus || 'Deactivated'}. Please contact support.`,
        403
      );
    }
    const summary: CustomerProfileSummary = {
      id: uidUser.id,
      customerId: code,
      webUserId: uidUser.id,
      authUserId: uidUser.authUserId || null,
      fullName: uidUser.fullName,
      email: uidUser.email,
      mobile: uidUser.mobile,
      companyOrCollege: uidUser.companyOrCollege,
      fullAddress: uidUser.fullAddress,
      city: uidUser.city,
      state: uidUser.state,
      pinCode: uidUser.pinCode,
      accountStatus: uidUser.accountStatus || 'Active',
      registrationDate: new Date(uidUser.createdAt).toISOString(),
      lastLoginAt: uidUser.lastLoginAt ? new Date(uidUser.lastLoginAt).toISOString() : null,
    };
    return {
      user: uidUser,
      activeProfile: summary,
      profiles: [summary],
      hasPassword: Boolean(uidUser.passwordHash || uidUser.passwordConfigured),
    };
  }

  const resolvedStatus = publicMatch?.accountStatus || localMatch?.accountStatus || 'Active';
  const isDeleted = Boolean(publicMatch?.deletedAt || localMatch?.deletedAt);
  if (isDeleted) {
    throw new AuthActionError(`Customer account ${code} has been removed.`, 404);
  }
  if (resolvedStatus !== 'Active') {
    throw new AuthActionError(
      `Customer account ${code} is currently ${resolvedStatus}. Please contact support.`,
      403
    );
  }

  const targetEmail = normalizeEmail(publicMatch?.email || localMatch?.email);
  const authUserId = publicMatch?.authUserId || localMatch?.authUserId || '';
  const linkedUser = await ensureLocalUserForCustomerProfile({
    authUserId: authUserId || (publicMatch?.userUid || code),
    email: targetEmail,
    emailConfirmedAt: publicMatch?.emailConfirmedAt || undefined,
    publicRecord: publicMatch || null,
    localCustomer: localMatch || null,
  });

  if (ADMIN_ROLES_SET.has(linkedUser.role)) {
    throw new AuthActionError(
      'Administrator accounts must sign in through the separate Admin Login portal (/admin/login).',
      403
    );
  }
  if (!linkedUser.isActive || linkedUser.accountStatus !== 'Active') {
    throw new AuthActionError(
      `Customer account ${code} is currently ${linkedUser.accountStatus || 'Deactivated'}.`,
      403
    );
  }

  const listRes = await listActiveCustomerProfilesForAuth({
    authUserId: linkedUser.authUserId || authUserId || '',
    email: linkedUser.email,
  }).catch(() => null);

  const summary = publicMatch
    ? { ...mapPublicRecordToSummary(publicMatch), webUserId: linkedUser.id }
    : { ...mapLocalCustToSummary(localMatch!), webUserId: linkedUser.id };

  const hasPassword = Boolean(
    linkedUser.passwordHash ||
      linkedUser.passwordConfigured ||
      localMatch?.passwordConfigured
  );

  return {
    user: linkedUser,
    activeProfile: summary,
    profiles: listRes?.activeProfiles && listRes.activeProfiles.length > 0 ? listRes.activeProfiles : [summary],
    hasPassword,
  };
}

export async function verifyCustomerIdPasswordLogin(
  rawCustomerId: string,
  password: string
): Promise<{
  user: typeof users.$inferSelect;
  activeProfile: CustomerProfileSummary;
  profiles: CustomerProfileSummary[];
}> {
  const cleanPassword = String(password || '');
  if (!cleanPassword) {
    throw new AuthActionError('Password is required.', 400);
  }

  const resolved = await resolveCustomerForCustomerIdAuth(rawCustomerId);
  const { user, activeProfile, profiles } = resolved;

  if (ADMIN_ROLES_SET.has(user.role)) {
    throw new AuthActionError(
      'Administrator accounts must sign in through the separate Admin Login portal (/admin/login).',
      403
    );
  }

  let verified = false;
  if (user.passwordHash) {
    verified = verifyPassword(cleanPassword, user.passwordHash);
  } else if (resolved.hasPassword) {
    const anonClient = createAnonServerSupabaseClient();
    if (anonClient) {
      const { data, error } = await anonClient.auth.signInWithPassword({
        email: normalizeEmail(user.email),
        password: cleanPassword,
      });
      if (!error && data?.user?.id) {
        verified = true;
      }
    }
  } else {
    throw new AuthActionError(
      'Password login is not configured for this Customer ID yet. Sign in via Email OTP and set a password in My Account -> Settings.',
      400
    );
  }

  if (!verified) {
    throw new AuthActionError('Invalid Customer ID or password.', 401);
  }

  const now = new Date();
  const [updatedUser] = await db
    .update(users)
    .set({ lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, user.id))
    .returning();

  return {
    user: updatedUser || user,
    activeProfile,
    profiles,
  };
}

export async function getOrCreateUser(
  uid: string,
  email: string,
  fullName?: string,
  extra?: {
    phone?: string;
    companyOrCollege?: string;
    emailConfirmedAt?: string;
    phoneConfirmedAt?: string;
  }
) {
  try {
    const cleanEmail = normalizeEmail(email);
    const authUuid = isUuid(uid) ? uid : null;
    const incomingPhone = normalizeMobile(extra?.phone);
    const incomingCompany = String(extra?.companyOrCollege || '').trim();
    const shouldBeSuperAdmin = cleanEmail ? isBootstrapAdminEmail(cleanEmail) : false;
    const emailVerified = Boolean(extra?.emailConfirmedAt);
    const phoneVerified = Boolean(extra?.phoneConfirmedAt);

    const publicReady = await isPublicCustomersSchemaReady();
    const publicCust =
      publicReady && !shouldBeSuperAdmin
        ? await findPublicCustomerForUser({ authUserId: authUuid, uid, email: cleanEmail })
        : null;

    const safeIncomingPhone = incomingPhone;

    const existing = await db
      .select()
      .from(users)
      .where(
        and(
          isNull(users.deletedAt),
          shouldBeSuperAdmin ? inArray(users.role, Array.from(ADMIN_ROLES_SET)) : eq(users.role, 'customer'),
          authUuid ? or(eq(users.authUserId, authUuid), eq(users.uid, uid)) : eq(users.uid, uid)
        )
      )
      .limit(1);

    let resultUser: typeof users.$inferSelect;

    if (existing.length > 0) {
      const current = existing[0];
      // Preserve existing role & uid strictly — never convert a customer account into Admin or mutate UUIDs
      const [updated] = await db
        .update(users)
        .set({
          authUserId: authUuid || current.authUserId,
          email: cleanEmail || current.email,
          fullName: publicCust?.fullName || current.fullName || fullName || '',
          mobile: publicCust?.phoneNumber || current.mobile || safeIncomingPhone,
          companyOrCollege: publicCust?.companyOrCollege || current.companyOrCollege || incomingCompany,
          accountStatus: publicCust ? publicCust.accountStatus : current.accountStatus,
          isActive: publicCust ? publicCust.accountStatus === 'Active' : current.isActive,
          emailVerified: current.emailVerified || emailVerified,
          phoneVerified: current.phoneVerified || phoneVerified,
          emailConfirmedAt: extra?.emailConfirmedAt || current.emailConfirmedAt,
          phoneConfirmedAt: extra?.phoneConfirmedAt || current.phoneConfirmedAt,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, current.id))
        .returning();
      resultUser = updated;
    } else if (cleanEmail) {
      const byEmail = await db
        .select()
        .from(users)
        .where(
          and(
            sql`lower(${users.email}) = ${cleanEmail}`,
            isNull(users.deletedAt),
            shouldBeSuperAdmin ? inArray(users.role, Array.from(ADMIN_ROLES_SET)) : eq(users.role, 'customer')
          )
        )
        .limit(1);

      if (byEmail.length > 0) {
        const current = byEmail[0];
        const [linked] = await db
          .update(users)
          .set({
            authUserId: authUuid || current.authUserId,
            fullName: publicCust?.fullName || current.fullName || fullName || '',
            mobile: publicCust?.phoneNumber || current.mobile || safeIncomingPhone,
            companyOrCollege: publicCust?.companyOrCollege || current.companyOrCollege || incomingCompany,
            accountStatus: publicCust ? publicCust.accountStatus : current.accountStatus,
            isActive: publicCust ? publicCust.accountStatus === 'Active' : current.isActive,
            emailVerified: current.emailVerified || emailVerified,
            phoneVerified: current.phoneVerified || phoneVerified,
            emailConfirmedAt: extra?.emailConfirmedAt || current.emailConfirmedAt,
            phoneConfirmedAt: extra?.phoneConfirmedAt || current.phoneConfirmedAt,
            lastLoginAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, current.id))
          .returning();
        resultUser = linked;
      } else {
        const isolatedAdminUid =
          shouldBeSuperAdmin
            ? `admin_${crypto.randomBytes(6).toString('hex')}`
            : uid;
        const [existingUidCollision] = shouldBeSuperAdmin
          ? await db.select({ id: users.id }).from(users).where(eq(users.uid, uid)).limit(1)
          : [];
        const insertUid = existingUidCollision ? isolatedAdminUid : uid;
        const [inserted] = await db
          .insert(users)
          .values({
            uid: insertUid,
            authUserId: authUuid,
            email: cleanEmail,
            fullName: publicCust?.fullName || fullName || '',
            mobile: publicCust?.phoneNumber || safeIncomingPhone,
            companyOrCollege: publicCust?.companyOrCollege || incomingCompany,
            fullAddress: publicCust?.fullAddress || '',
            city: publicCust?.city || '',
            state: publicCust?.state || '',
            pinCode: publicCust?.pinCode || '',
            passwordHash: null,
            emailVerified,
            phoneVerified,
            emailConfirmedAt: extra?.emailConfirmedAt || '',
            phoneConfirmedAt: extra?.phoneConfirmedAt || '',
            role: shouldBeSuperAdmin ? 'super_admin' : 'customer',
            accountStatus: publicCust ? publicCust.accountStatus : 'Active',
            isActive: publicCust ? publicCust.accountStatus === 'Active' : true,
            lastLoginAt: new Date(),
          })
          .onConflictDoUpdate({
            target: users.uid,
            set: {
              authUserId: authUuid,
              email: cleanEmail,
              mobile: publicCust?.phoneNumber || safeIncomingPhone,
              companyOrCollege: publicCust?.companyOrCollege || incomingCompany,
              emailVerified,
              phoneVerified,
              lastLoginAt: new Date(),
              updatedAt: new Date(),
            },
          })
          .returning();
        resultUser = inserted;
      }
    } else {
      const [inserted] = await db
        .insert(users)
        .values({
          uid,
          authUserId: authUuid,
          email: cleanEmail,
          fullName: fullName || '',
          mobile: safeIncomingPhone,
          companyOrCollege: incomingCompany,
          passwordHash: null,
          emailVerified,
          phoneVerified,
          emailConfirmedAt: extra?.emailConfirmedAt || '',
          phoneConfirmedAt: extra?.phoneConfirmedAt || '',
          role: 'customer',
          accountStatus: 'Active',
          isActive: true,
          lastLoginAt: new Date(),
        })
        .onConflictDoUpdate({
          target: users.uid,
          set: { authUserId: authUuid, email: cleanEmail, lastLoginAt: new Date(), updatedAt: new Date() },
        })
        .returning();
      resultUser = inserted;
    }

    // Enforce Supabase public.customers synchronization for non-staff customer accounts
    if (publicReady && !ADMIN_ROLES_SET.has(resultUser.role)) {
      const hasRealPostgres = Boolean(createPool());
      if (publicCust) {
        if (publicCust.deletedAt) {
          throw new AuthActionError('Your customer account has been removed.', 401);
        }
        await updatePublicCustomerRecord(publicCust.id, {
          ...(authUuid && publicCust.authUserId !== authUuid ? { authUserId: authUuid } : {}),
          ...(hasRealPostgres && publicCust.webUserId !== resultUser.id ? { webUserId: resultUser.id } : {}),
          lastLoginAt: new Date(),
        }).catch(() => {});
      } else if (cleanEmail) {
        // Ensure existing/new customer profile is persisted cleanly into public.customers
        await createPublicCustomerRecord({
          authUserId: authUuid,
          userUid: authUuid || resultUser.uid,
          ...(hasRealPostgres ? { webUserId: resultUser.id } : {}),
          fullName: resultUser.fullName || cleanEmail.split('@')[0],
          email: cleanEmail,
          phoneNumber: resultUser.mobile || safeIncomingPhone,
          companyOrCollege: resultUser.companyOrCollege || incomingCompany,
          accountStatus: resultUser.accountStatus || 'Active',
          lastLoginAt: new Date(),
        }).catch(() => {});
      }
    }

    import('../server/supabase-ecommerce.ts')
      .then(({ syncCustomerProfileToSupabase }) =>
        syncCustomerProfileToSupabase({
          uid: resultUser.uid,
          email: resultUser.email,
          fullName: resultUser.fullName,
          mobile: resultUser.mobile,
          companyOrCollege: resultUser.companyOrCollege,
          role: resultUser.role,
          emailVerified: resultUser.emailVerified,
          phoneVerified: resultUser.phoneVerified,
          emailConfirmedAt: resultUser.emailConfirmedAt,
          phoneConfirmedAt: resultUser.phoneConfirmedAt,
        })
      )
      .catch(() => {});

    return resultUser;
  } catch (error) {
    if (error instanceof AuthActionError) throw error;
    console.error('Failed to upsert user:', error);
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}

export async function getUserByUid(uid: string) {
  try {
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.uid, uid), isNull(users.deletedAt)))
      .limit(1);
    return rows[0] || null;
  } catch (error) {
    console.error('Failed to fetch user:', error);
    throw new Error('Failed to retrieve user record.', { cause: error });
  }
}
