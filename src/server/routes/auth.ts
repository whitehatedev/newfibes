import { Router } from 'express';
import {
  ADMIN_ROLES_SET,
  AuthActionError,
  completeCustomerRegistrationFromOtp,
  createAdminSession,
  deleteAdminSession,
  ensureInitialAdminUser,
  getAdminSetupStatus,
  getOrCreateUser,
  getStaffCustomerPermissions,
  isBootstrapAdminEmail,
  listActiveCustomerProfilesForAuth,
  resolveCustomerForCustomerIdAuth,
  resolveCustomerProfilesByVerifiedAuth,
  selectCustomerProfileForAuthUser,
  updateUserPassword,
  verifyAdminCredentials,
  verifyCustomerIdPasswordLogin,
} from '../../db/users.ts';
import {
  ADMIN_SESSION_COOKIE,
  AuthRequest,
  optionalAuth,
  requireAdmin,
  requireAuth,
  USER_SESSION_COOKIE,
} from '../../middleware/auth.ts';
import { logAudit, parseCookies, verifyPassword } from '../utils.ts';
import { db } from '../../db/index.ts';
import { customerActivityLogs, users } from '../../db/schema.ts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getSupabasePublicConfig, verifySupabaseAccessToken } from '../../lib/supabase-admin.ts';
import { getDashboardRouteForRole } from '../../lib/rbac.ts';
import { syncActivityLogToSupabase } from '../supabase-ecommerce.ts';

const DEFAULT_NOTIFICATION_PREFS = {
  emailUpdates: true,
  orderAlerts: true,
  quotationAlerts: true,
  promotionalEmails: false,
  whatsappAlerts: true,
};

function maskEmailAddress(email: string): string {
  const clean = String(email || '').trim();
  const [local, domain] = clean.split('@');
  if (!local || !domain) return clean;
  if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
  return `${local.slice(0, 2)}${'*'.repeat(Math.min(6, Math.max(2, local.length - 2)))}@${domain}`;
}

function isHttpsRequest(req: { secure?: boolean; headers: Record<string, any> }): boolean {
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return Boolean(req.secure || proto === 'https' || (process.env.APP_URL || '').startsWith('https://'));
}

function buildCookieOptions(req: { secure?: boolean; headers: Record<string, any> }, expires?: Date) {
  const isHttps = isHttpsRequest(req);
  return {
    httpOnly: true,
    sameSite: (isHttps ? 'none' : 'lax') as 'none' | 'lax',
    secure: isHttps,
    path: '/',
    ...(expires ? { expires } : {}),
  };
}

async function revokeAndClearCookies(
  req: { secure?: boolean; headers: Record<string, any> },
  res: any,
  which: Array<'user' | 'admin'> = ['user', 'admin']
) {
  const cookies = parseCookies(req.headers.cookie);
  const clearOpts = buildCookieOptions(req);
  if (which.includes('user')) {
    if (cookies[USER_SESSION_COOKIE]) {
      await deleteAdminSession(cookies[USER_SESSION_COOKIE]).catch(() => {});
    }
    res.clearCookie(USER_SESSION_COOKIE, clearOpts);
  }
  if (which.includes('admin')) {
    if (cookies[ADMIN_SESSION_COOKIE]) {
      await deleteAdminSession(cookies[ADMIN_SESSION_COOKIE]).catch(() => {});
    }
    res.clearCookie(ADMIN_SESSION_COOKIE, clearOpts);
  }
}

function serializeSafeUser(
  u: {
    id: number;
    uid: string;
    customerId?: string;
    authUserId?: string | null;
    email: string;
    fullName: string;
    mobile: string;
    companyOrCollege: string;
    fullAddress?: string;
    city?: string;
    state?: string;
    pinCode?: string;
    role: string;
    emailVerified?: boolean;
    phoneVerified?: boolean;
    isActive?: boolean;
    passwordHash?: string | null;
    passwordConfigured?: boolean;
    notificationPreferences?: any;
  },
  activeCustomerId?: string
) {
  const isStaff = ADMIN_ROLES_SET.has(u.role);
  const effectiveCustomerId = isStaff
    ? ''
    : activeCustomerId || u.customerId || (u.uid?.startsWith('NTF-CUST-') ? u.uid : '');
  const hasPassword = Boolean(u.passwordHash || u.passwordConfigured);
  return {
    id: u.id,
    uid: u.uid,
    ...(effectiveCustomerId ? { customerId: effectiveCustomerId } : {}),
    email: u.email,
    fullName: u.fullName,
    mobile: u.mobile,
    companyOrCollege: u.companyOrCollege,
    fullAddress: u.fullAddress || '',
    city: u.city || '',
    state: u.state || '',
    pinCode: u.pinCode || '',
    role: u.role,
    emailVerified: u.emailVerified,
    phoneVerified: u.phoneVerified,
    isActive: u.isActive,
    hasPassword,
    passwordConfigured: hasPassword,
    notificationPreferences: {
      ...DEFAULT_NOTIFICATION_PREFS,
      ...(u.notificationPreferences && typeof u.notificationPreferences === 'object'
        ? u.notificationPreferences
        : {}),
    },
  };
}

function extractBearerToken(req: { headers: Record<string, any> }): string {
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) return '';
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token || token === 'null' || token === 'undefined') return '';
  return token;
}

export const authRouter = Router();

authRouter.get('/session', optionalAuth, async (req: AuthRequest, res) => {
  if (!req.dbUser) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[USER_SESSION_COOKIE] || cookies[ADMIN_SESSION_COOKIE]) {
      const clearOpts = buildCookieOptions(req);
      res.clearCookie(USER_SESSION_COOKIE, clearOpts);
      res.clearCookie(ADMIN_SESSION_COOKIE, clearOpts);
    }
    return res.json({
      authenticated: false,
      user: null,
      availableProfiles: [],
      sessionScope: null,
      redirectTo: null,
    });
  }

  let availableProfiles: any[] = [];
  let customerPermissions = null;

  if (ADMIN_ROLES_SET.has(req.dbUser.role)) {
    customerPermissions = await getStaffCustomerPermissions({
      id: req.dbUser.id,
      role: req.dbUser.role,
    }).catch(() => null);
  } else {
    const listRes = await listActiveCustomerProfilesForAuth({
      authUserId: req.dbUser.authUserId || '',
      email: req.dbUser.email,
    }).catch(() => null);
    availableProfiles = listRes?.activeProfiles || [];
  }

  const sessionScope =
    req.sessionScope || (ADMIN_ROLES_SET.has(req.dbUser.role) ? 'admin' : 'customer');

  return res.json({
    authenticated: true,
    sessionScope,
    redirectTo: getDashboardRouteForRole(req.dbUser.role),
    user: serializeSafeUser(req.dbUser, req.activeCustomerId),
    availableProfiles,
    customerPermissions,
  });
});

authRouter.get('/oauth-status', async (req, res) => {
  const pub = getSupabasePublicConfig();
  const envAppUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const origin = envAppUrl || `${proto}://${req.get('host') || 'localhost:3000'}`;
  const redirectTo = `${origin}/auth/callback`;

  let googleProviderReady: boolean | null = null;
  let googleProviderError: string | null = null;

  if (pub.configured && req.query.probe === 'google') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const probeRes = await fetch(
        `${pub.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`,
        { redirect: 'manual', signal: controller.signal }
      );
      clearTimeout(timer);

      if (probeRes.status >= 300 && probeRes.status < 400) {
        googleProviderReady = true;
      } else {
        googleProviderReady = false;
        const body = (await probeRes.json().catch(() => ({}))) as { msg?: string; error_code?: string };
        googleProviderError = body?.msg || `HTTP ${probeRes.status}`;
      }
    } catch {
      googleProviderReady = null;
    }
  }

  res.json({
    supabaseConfigured: pub.configured,
    supabaseUrlOrigin: pub.url || null,
    supabaseCallbackUrl: pub.url ? `${pub.url}/auth/v1/callback` : null,
    googleProviderReady,
    googleProviderError,
    recommendedRedirectUrls: Array.from(
      new Set([
        redirectTo,
        `${origin}/auth/callback`,
      ])
    ),
  });
});

// Staff / Admin OAuth sync only (customer Google OAuth removed)
authRouter.post('/sync-profile', optionalAuth, async (req: AuthRequest, res) => {
  try {
    let userRow: any = req.dbUser && ADMIN_ROLES_SET.has(req.dbUser.role) ? req.dbUser : null;
    if (!userRow) {
      const token = extractBearerToken(req);
      if (!token) {
        return res.status(401).json({ error: 'Authentication required. Please sign in.' });
      }
      const verified = await verifySupabaseAccessToken(token);
      if (!verified || !verified.email) {
        return res.status(401).json({ error: 'Invalid or expired OAuth session token.' });
      }
      if (!isBootstrapAdminEmail(verified.email)) {
        return res.status(403).json({
          error: 'Google Sign-In is restricted to authorized staff & admin accounts. Customers sign in via Email OTP.',
        });
      }
      userRow = await getOrCreateUser(verified.uid, verified.email, verified.fullName, {
        phone: verified.phone,
        emailConfirmedAt: verified.emailConfirmedAt,
        phoneConfirmedAt: verified.phoneConfirmedAt,
      });
    }

    if (!ADMIN_ROLES_SET.has(userRow.role)) {
      return res.status(403).json({
        error: 'Google Sign-In is disabled for customer accounts. Please sign in using Email OTP.',
      });
    }
    if (userRow.isActive === false) {
      return res.status(403).json({ error: 'This staff account has been deactivated.' });
    }

    // Revoke any prior customer/admin cookies so admin session is strictly isolated
    await revokeAndClearCookies(req, res, ['user', 'admin']);

    const ua = String(req.headers['user-agent'] || '');
    const session = await createAdminSession(userRow.id, ua, '', 'admin');
    res.cookie(ADMIN_SESSION_COOKIE, session.cookieValue, buildCookieOptions(req, session.expiresAt));
    const customerPermissions = await getStaffCustomerPermissions({
      id: userRow.id,
      role: userRow.role,
    }).catch(() => null);
    res.json({
      sessionToken: session.cookieValue,
      sessionScope: 'admin',
      redirectTo: getDashboardRouteForRole(userRow.role),
      user: serializeSafeUser(userRow),
      customerPermissions,
    });
  } catch (error) {
    console.error('OAuth profile sync error:', error);
    res.status(500).json({ error: 'Failed to synchronize OAuth profile.' });
  }
});

// Customer Email OTP Session Exchange (STRICTLY Customer-only — never issues Admin sessions)
authRouter.post('/otp/session', async (req, res) => {
  try {
    await ensureInitialAdminUser();
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Verified Supabase OTP access token is required.' });
    }
    const verified = await verifySupabaseAccessToken(token);
    if (!verified || !verified.email) {
      return res.status(401).json({ error: 'Invalid or expired OTP session token. Please request a new code.' });
    }

    const resolution = await resolveCustomerProfilesByVerifiedAuth({
      authUserId: verified.uid,
      email: verified.email,
      emailConfirmedAt: verified.emailConfirmedAt,
      customerOnly: true,
    });

    if (resolution.kind === 'needs_registration') {
      return res.json({
        status: 'needs_registration',
        email: resolution.email,
        authUserId: resolution.authUserId,
      });
    }

    if (resolution.kind === 'select_profile') {
      return res.json({
        status: 'select_profile',
        email: resolution.email,
        authUserId: resolution.authUserId,
        profiles: resolution.profiles,
      });
    }

    if (resolution.kind === 'staff' || ADMIN_ROLES_SET.has(resolution.user.role)) {
      return res.status(403).json({
        error: 'Administrator accounts must sign in through the separate Admin Login portal (/admin/login).',
      });
    }

    // Revoke and clear any previous admin or customer cookie so customer session cannot inherit admin access
    await revokeAndClearCookies(req, res, ['admin', 'user']);

    const ua = String(req.headers['user-agent'] || '');
    const session = await createAdminSession(
      resolution.user.id,
      ua,
      resolution.activeProfile.customerId,
      'customer'
    );
    res.cookie(USER_SESSION_COOKIE, session.cookieValue, buildCookieOptions(req, session.expiresAt));

    await logAudit({
      actorUid: resolution.activeProfile.customerId,
      actorEmail: resolution.user.email,
      action: 'CUSTOMER_OTP_LOGIN',
      entityType: 'customer',
      entityId: String(resolution.activeProfile.id),
      details: { customerId: resolution.activeProfile.customerId, role: resolution.user.role },
    });

    await db
      .insert(customerActivityLogs)
      .values({
        userId: resolution.user.id,
        customerId: resolution.activeProfile.customerId,
        email: resolution.user.email,
        category: 'security',
        action: 'CUSTOMER_OTP_LOGIN',
        entityType: 'auth',
        entityId: resolution.activeProfile.customerId,
        description: 'Signed in via verified Email OTP.',
        metadata: { method: 'email_otp' },
      })
      .catch(() => {});
    syncActivityLogToSupabase({
      userUid: resolution.user.uid,
      customerId: resolution.activeProfile.customerId,
      action: 'CUSTOMER_OTP_LOGIN',
      entityType: 'auth',
      entityId: resolution.activeProfile.customerId,
      details: { method: 'email_otp' },
    }).catch(() => {});

    return res.json({
      status: 'authenticated',
      sessionToken: session.cookieValue,
      sessionScope: 'customer',
      redirectTo: getDashboardRouteForRole(resolution.user.role),
      user: serializeSafeUser(resolution.user, resolution.activeProfile.customerId),
      activeProfile: resolution.activeProfile,
      availableProfiles: resolution.profiles,
    });
  } catch (error: any) {
    const status = error instanceof AuthActionError ? error.statusCode : 500;
    if (status >= 500) {
      console.error('OTP session resolution error:', error);
    }
    return res.status(status).json({ error: error?.message || 'Unable to verify OTP session.' });
  }
});

// Select an individual customer profile (supports both post-OTP selection and switching profiles inside dashboard)
authRouter.post('/select-profile', optionalAuth, async (req: AuthRequest, res) => {
  try {
    const customerId = String(req.body?.customerId || '').trim();
    if (!customerId) {
      return res.status(400).json({ error: 'Please select a valid customer profile ID.' });
    }

    let authUserId = '';
    let email = '';
    let emailConfirmedAt = '';

    const token = extractBearerToken(req);
    if (token) {
      const verified = await verifySupabaseAccessToken(token).catch(() => null);
      if (verified?.email) {
        authUserId = verified.uid;
        email = verified.email;
        emailConfirmedAt = verified.emailConfirmedAt || '';
      }
    }

    if (!email && req.dbUser && !ADMIN_ROLES_SET.has(req.dbUser.role)) {
      authUserId = req.dbUser.authUserId || '';
      email = req.dbUser.email || '';
    }

    if (!email) {
      return res.status(401).json({ error: 'Authentication required to select customer profile.' });
    }

    const result = await selectCustomerProfileForAuthUser({
      authUserId,
      email,
      customerId,
      emailConfirmedAt,
    });

    if (ADMIN_ROLES_SET.has(result.user.role)) {
      return res.status(403).json({
        error: 'Administrator accounts must sign in through the Admin Login portal (/admin/login).',
      });
    }

    // Revoke and clear any prior admin/user cookies
    await revokeAndClearCookies(req, res, ['admin', 'user']);

    const ua = String(req.headers['user-agent'] || '');
    const session = await createAdminSession(
      result.user.id,
      ua,
      result.activeProfile.customerId,
      'customer'
    );
    res.cookie(USER_SESSION_COOKIE, session.cookieValue, buildCookieOptions(req, session.expiresAt));

    return res.json({
      status: 'authenticated',
      sessionToken: session.cookieValue,
      sessionScope: 'customer',
      redirectTo: getDashboardRouteForRole(result.user.role),
      user: serializeSafeUser(result.user, result.activeProfile.customerId),
      activeProfile: result.activeProfile,
      availableProfiles: result.profiles,
    });
  } catch (error: any) {
    const status = error instanceof AuthActionError ? error.statusCode : 500;
    return res.status(status).json({ error: error?.message || 'Failed to select customer profile.' });
  }
});

// Complete Customer Profile Registration after Email OTP Verification (NO password)
authRouter.post('/complete-registration', optionalAuth, async (req: AuthRequest, res) => {
  try {
    let authUserId = '';
    let email = '';
    let emailConfirmedAt = '';

    const token = extractBearerToken(req);
    if (token) {
      const verified = await verifySupabaseAccessToken(token).catch(() => null);
      if (verified?.email) {
        authUserId = verified.uid;
        email = verified.email;
        emailConfirmedAt = verified.emailConfirmedAt || '';
      }
    }

    if ((!authUserId || !email) && req.dbUser && !ADMIN_ROLES_SET.has(req.dbUser.role)) {
      authUserId = req.dbUser.authUserId || '';
      email = req.dbUser.email || '';
    }

    if (!authUserId || !email) {
      return res.status(401).json({
        error: 'Please verify your email via OTP before completing registration.',
      });
    }

    const result = await completeCustomerRegistrationFromOtp({
      authUserId,
      email,
      emailConfirmedAt,
      fullName: String(req.body?.fullName || '').trim(),
      mobile: String(req.body?.mobile || '').trim(),
      companyOrCollege: String(req.body?.companyOrCollege || '').trim(),
      fullAddress: String(req.body?.fullAddress || '').trim(),
      city: String(req.body?.city || '').trim(),
      state: String(req.body?.state || '').trim(),
      pinCode: String(req.body?.pinCode || '').trim(),
    });

    if (ADMIN_ROLES_SET.has(result.user.role)) {
      return res.status(403).json({
        error: 'Administrator accounts cannot be issued a customer registration session.',
      });
    }

    // Revoke and clear any previous admin/user cookies
    await revokeAndClearCookies(req, res, ['admin', 'user']);

    const ua = String(req.headers['user-agent'] || '');
    const session = await createAdminSession(
      result.user.id,
      ua,
      result.activeProfile.customerId,
      'customer'
    );
    res.cookie(USER_SESSION_COOKIE, session.cookieValue, buildCookieOptions(req, session.expiresAt));

    await logAudit({
      actorUid: result.activeProfile.customerId,
      actorEmail: result.user.email,
      action: 'CUSTOMER_OTP_REGISTERED',
      entityType: 'customer',
      entityId: String(result.activeProfile.id),
      details: {
        customerId: result.activeProfile.customerId,
        authProvider: 'supabase_email_otp',
      },
    });

    await db
      .insert(customerActivityLogs)
      .values({
        userId: result.user.id,
        customerId: result.activeProfile.customerId,
        email: result.user.email,
        category: 'account',
        action: 'CUSTOMER_ACCOUNT_CREATED',
        entityType: 'customer',
        entityId: result.activeProfile.customerId,
        description: 'Customer profile registered after Email OTP verification.',
        metadata: { authProvider: 'supabase_email_otp' },
      })
      .catch(() => {});
    syncActivityLogToSupabase({
      userUid: result.user.uid,
      customerId: result.activeProfile.customerId,
      action: 'CUSTOMER_ACCOUNT_CREATED',
      entityType: 'customer',
      entityId: result.activeProfile.customerId,
      details: { authProvider: 'supabase_email_otp' },
    }).catch(() => {});

    return res.status(201).json({
      status: 'authenticated',
      sessionToken: session.cookieValue,
      sessionScope: 'customer',
      redirectTo: getDashboardRouteForRole(result.user.role),
      customerId: result.activeProfile.customerId,
      user: serializeSafeUser(result.user, result.activeProfile.customerId),
      activeProfile: result.activeProfile,
      availableProfiles: result.profiles,
    });
  } catch (error: any) {
    const status = error instanceof AuthActionError ? error.statusCode : 400;
    if (status >= 500) {
      console.error('Complete OTP registration error:', error);
    }
    return res.status(status).json({ error: error?.message || 'Registration failed.' });
  }
});

// Lookup Customer ID -> resolves linked email for OTP or password sign-in (strictly customer-only)
authRouter.post('/customer-id-lookup', async (req, res) => {
  try {
    await ensureInitialAdminUser();
    const customerId = String(req.body?.customerId || '').trim();
    if (!customerId) {
      return res.status(400).json({ error: 'Customer ID is required (e.g., NTF-CUST-000001).' });
    }
    const resolved = await resolveCustomerForCustomerIdAuth(customerId);
    return res.json({
      customerId: resolved.activeProfile.customerId,
      fullName: resolved.activeProfile.fullName,
      email: resolved.activeProfile.email,
      maskedEmail: maskEmailAddress(resolved.activeProfile.email),
      hasPassword: resolved.hasPassword,
      accountStatus: resolved.activeProfile.accountStatus,
    });
  } catch (error: any) {
    const status = error instanceof AuthActionError ? error.statusCode : 400;
    return res.status(status).json({ error: error?.message || 'Unable to locate Customer ID.' });
  }
});

// Customer ID + Password Login (STRICTLY customer-only — never grants admin sessions)
authRouter.post('/customer-id-login', async (req, res) => {
  try {
    await ensureInitialAdminUser();
    const customerId = String(req.body?.customerId || '').trim();
    const password = String(req.body?.password || '');
    if (!customerId || !password) {
      return res.status(400).json({ error: 'Customer ID and password are required.' });
    }

    const result = await verifyCustomerIdPasswordLogin(customerId, password);
    if (ADMIN_ROLES_SET.has(result.user.role)) {
      return res.status(403).json({
        error: 'Administrator accounts must sign in through the separate Admin Login portal (/admin/login).',
      });
    }

    await revokeAndClearCookies(req, res, ['admin', 'user']);
    const ua = String(req.headers['user-agent'] || '');
    const session = await createAdminSession(
      result.user.id,
      ua,
      result.activeProfile.customerId,
      'customer'
    );
    res.cookie(USER_SESSION_COOKIE, session.cookieValue, buildCookieOptions(req, session.expiresAt));

    await logAudit({
      actorUid: result.activeProfile.customerId,
      actorEmail: result.user.email,
      action: 'CUSTOMER_ID_PASSWORD_LOGIN',
      entityType: 'customer',
      entityId: String(result.activeProfile.id),
      details: { customerId: result.activeProfile.customerId, role: result.user.role },
    });

    await db
      .insert(customerActivityLogs)
      .values({
        userId: result.user.id,
        customerId: result.activeProfile.customerId,
        email: result.user.email,
        category: 'security',
        action: 'CUSTOMER_ID_PASSWORD_LOGIN',
        entityType: 'auth',
        entityId: result.activeProfile.customerId,
        description: 'Signed in using Customer ID and password.',
        metadata: { method: 'customer_id_password' },
      })
      .catch(() => {});
    syncActivityLogToSupabase({
      userUid: result.user.uid,
      customerId: result.activeProfile.customerId,
      action: 'CUSTOMER_ID_PASSWORD_LOGIN',
      entityType: 'auth',
      entityId: result.activeProfile.customerId,
      details: { method: 'customer_id_password' },
    }).catch(() => {});

    return res.json({
      status: 'authenticated',
      sessionToken: session.cookieValue,
      sessionScope: 'customer',
      redirectTo: getDashboardRouteForRole(result.user.role),
      user: serializeSafeUser(result.user, result.activeProfile.customerId),
      activeProfile: result.activeProfile,
      availableProfiles: result.profiles,
    });
  } catch (error: any) {
    const status = error instanceof AuthActionError ? error.statusCode : 401;
    if (status >= 500) {
      console.error('Customer ID login error:', error);
    }
    return res.status(status).json({ error: error?.message || 'Unable to sign in with Customer ID.' });
  }
});

// Customer password login & registration removed — Email OTP only
authRouter.post('/register', (_req, res) => {
  res.status(410).json({
    error: 'Password registration has been removed. Please verify your email using Email OTP to register.',
    code: 'EMAIL_OTP_REQUIRED',
  });
});

authRouter.post('/login', (_req, res) => {
  res.status(410).json({
    error: 'Password login has been removed for customers. Please sign in with your Email OTP.',
    code: 'EMAIL_OTP_REQUIRED',
  });
});

authRouter.post('/logout', async (req, res) => {
  try {
    await revokeAndClearCookies(req, res, ['user', 'admin']);
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      await deleteAdminSession(authHeader.split('Bearer ')[1]).catch(() => {});
    }
  } catch {
    // ignore
  }
  res.json({ ok: true });
});

authRouter.get('/admin-setup-status', async (_req, res) => {
  try {
    await ensureInitialAdminUser();
    const status = await getAdminSetupStatus();
    res.json(status);
  } catch {
    res.status(500).json({ error: 'Failed to inspect admin setup status.' });
  }
});

authRouter.post('/admin-login', async (req, res) => {
  try {
    await ensureInitialAdminUser();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await verifyAdminCredentials(email, password);
    if (!user || !ADMIN_ROLES_SET.has(user.role)) {
      await logAudit({
        actorUid: 'anonymous',
        actorEmail: email,
        action: 'ADMIN_LOGIN_FAILED',
        entityType: 'admin_auth',
        details: { reason: 'Invalid credentials or unauthorized role' },
      });
      return res.status(401).json({ error: 'Invalid admin email or password.' });
    }

    // Revoke and clear any prior customer or admin session cookies
    await revokeAndClearCookies(req, res, ['user', 'admin']);
    const bearer = extractBearerToken(req);
    if (bearer) {
      await deleteAdminSession(bearer).catch(() => {});
    }

    const ua = String(req.headers['user-agent'] || '');
    const session = await createAdminSession(user.id, ua, '', 'admin');

    res.cookie(ADMIN_SESSION_COOKIE, session.cookieValue, buildCookieOptions(req, session.expiresAt));

    await logAudit({
      actorUid: user.uid,
      actorEmail: user.email,
      action: 'ADMIN_LOGIN_SUCCESS',
      entityType: 'admin_auth',
      entityId: user.id,
      details: { role: user.role },
    });

    res.json({
      sessionToken: session.cookieValue,
      sessionScope: 'admin',
      redirectTo: getDashboardRouteForRole(user.role),
      user: serializeSafeUser(user),
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Unable to sign in right now.' });
  }
});

authRouter.post('/admin-logout', async (req, res) => {
  try {
    await revokeAndClearCookies(req, res, ['admin', 'user']);
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      await deleteAdminSession(authHeader.split('Bearer ')[1]).catch(() => {});
    }
  } catch {
    // ignore
  }
  res.json({ ok: true });
});

authRouter.post('/admin-change-password', requireAuth, requireAdmin(), async (req: AuthRequest, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    }

    const [userRow] = await db.select().from(users).where(eq(users.id, req.dbUser!.id)).limit(1);
    if (!userRow) return res.status(404).json({ error: 'User not found.' });

    if (userRow.passwordHash) {
      if (!verifyPassword(currentPassword, userRow.passwordHash)) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
    } else {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required.' });
      }
      const { createAnonServerSupabaseClient } = await import('../../lib/supabase-admin.ts');
      const anonClient = createAnonServerSupabaseClient();
      if (anonClient) {
        const { error: checkErr } = await anonClient.auth.signInWithPassword({
          email: userRow.email,
          password: currentPassword,
        });
        if (checkErr) {
          return res.status(400).json({ error: 'Current password is incorrect.' });
        }
      }
    }

    await updateUserPassword(userRow.id, newPassword);
    await logAudit({
      actorUid: userRow.uid,
      actorEmail: userRow.email,
      action: 'ADMIN_PASSWORD_CHANGED',
      entityType: 'user',
      entityId: userRow.id,
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Password update error:', error);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// Admin Forgot / Reset Password (Email-dispatched short-lived token)
const passwordResetTokens = new Map<string, { userId: number; email: string; expiresAt: number }>();

authRouter.post('/admin-forgot-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Admin email is required.' });

    const [userRow] = await db
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
    if (!userRow || !ADMIN_ROLES_SET.has(userRow.role) || !userRow.isActive) {
      // Return neutral confirmation to avoid account enumeration
      return res.json({ ok: true, message: 'If an active administrator account matches this email, recovery instructions have been dispatched.' });
    }

    const crypto = await import('crypto');
    const token = crypto.randomBytes(24).toString('hex');
    passwordResetTokens.set(token, {
      userId: userRow.id,
      email: userRow.email,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    const { dispatchLifecycleEmail } = await import('../email.ts');
    const delivery = await dispatchLifecycleEmail({
      userId: userRow.id,
      recipientEmail: userRow.email,
      eventType: 'admin_password_reset',
      vars: {
        customerName: userRow.fullName || userRow.email,
        summary: `Use reset token ${token} (valid for 30 minutes) on the Admin Login Reset form.`,
      },
    });

    await logAudit({
      actorUid: userRow.uid,
      actorEmail: userRow.email,
      action: 'ADMIN_PASSWORD_RESET_REQUESTED',
      entityType: 'user',
      entityId: userRow.id,
      details: { deliveryStatus: delivery.deliveryStatus },
    });

    res.json({
      ok: true,
      deliveryStatus: delivery.deliveryStatus,
      message:
        delivery.deliveryStatus === 'sent'
          ? 'Recovery instructions sent to your administrator email.'
          : 'Contact Customer Care (info@nexustekfusion.in) or your Super Admin for password recovery.',
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password reset request.' });
  }
});

authRouter.post('/admin-reset-password', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    const newPassword = String(req.body.newPassword || '');
    if (!token || newPassword.length < 8) {
      return res.status(400).json({ error: 'Valid reset token and new password (min 8 chars) are required.' });
    }

    const entry = passwordResetTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
      passwordResetTokens.delete(token);
      return res.status(400).json({ error: 'Reset token is invalid or expired.' });
    }

    await updateUserPassword(entry.userId, newPassword);
    passwordResetTokens.delete(token);

    await logAudit({
      actorUid: String(entry.userId),
      actorEmail: entry.email,
      action: 'ADMIN_PASSWORD_RESET_COMPLETED',
      entityType: 'user',
      entityId: entry.userId,
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

