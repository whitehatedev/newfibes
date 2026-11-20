import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  User,
} from 'lucide-react';
import { usePlatform } from '../context/PlatformContext';
import { getDashboardRouteForRole, sanitizePostAuthRedirect } from '../lib/rbac';
import { CustomerProfileSummary } from '../types/platform';

interface CustomerOtpAuthProps {
  onComplete?: (destination: string) => void;
  defaultRedirect?: string;
  compact?: boolean;
}

export const CustomerOtpAuth: React.FC<CustomerOtpAuthProps> = ({
  onComplete,
  defaultRedirect = '/customer/dashboard',
  compact = false,
}) => {
  const {
    sendCustomerOtp,
    verifyCustomerOtp,
    selectCustomerProfile,
    completeCustomerRegistration,
    lookupCustomerId,
    signInWithCustomerId,
    pendingOtpState,
    clearPendingOtpState,
    consumePostAuthRedirect,
    navigate,
  } = usePlatform();

  const [step, setStep] = useState<'email' | 'customer_id' | 'otp' | 'select_profile' | 'register'>(() => {
    if (pendingOtpState?.step === 'select_profile') return 'select_profile';
    if (pendingOtpState?.step === 'complete_registration') return 'register';
    return 'email';
  });

  const [email, setEmail] = useState(() => pendingOtpState?.email || '');
  const [customerIdInput, setCustomerIdInput] = useState('');
  const [customerPassword, setCustomerPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [profiles, setProfiles] = useState<CustomerProfileSummary[]>(
    () => pendingOtpState?.profiles || []
  );

  // Registration / Profile completion fields (Email OTP only — NO passwords)
  const [fullName, setFullName] = useState('');
  const [mobile, setMobile] = useState('');
  const [companyOrCollege, setCompanyOrCollege] = useState('');
  const [fullAddress, setFullAddress] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [pinCode, setPinCode] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (pendingOtpState) {
      setEmail(pendingOtpState.email);
      setProfiles(pendingOtpState.profiles || []);
      setStep(pendingOtpState.step === 'select_profile' ? 'select_profile' : 'register');
    }
  }, [pendingOtpState]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  useEffect(() => {
    if (step === 'otp') {
      setTimeout(() => otpInputRefs.current[0]?.focus(), 50);
    }
  }, [step]);

  const finishAuth = (userRole?: string | null, overrideDest?: string) => {
    const resolvedRole = userRole || 'customer';
    const saved = consumePostAuthRedirect(resolvedRole);
    const candidate = overrideDest || (saved !== getDashboardRouteForRole(resolvedRole) ? saved : defaultRedirect) || getDashboardRouteForRole(resolvedRole);
    const dest = sanitizePostAuthRedirect(candidate, resolvedRole);
    if (onComplete) {
      onComplete(dest);
    } else {
      navigate(dest);
    }
  };

  const handleSendOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError('');
    setInfoMsg('');
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Please enter a valid email address.');
      return;
    }

    setBusy(true);
    try {
      await sendCustomerOtp(cleanEmail);
      setEmail(cleanEmail);
      setDigits(['', '', '', '', '', '']);
      setStep('otp');
      setResendCooldown(30);
      setInfoMsg(`A 6-digit verification code has been sent to ${cleanEmail}.`);
    } catch (err: any) {
      setError(err?.message || 'Unable to send OTP email.');
    } finally {
      setBusy(false);
    }
  };

  const handleDigitChange = (index: number, rawValue: string) => {
    const onlyDigits = rawValue.replace(/\D/g, '');
    if (!onlyDigits) {
      setDigits((prev) => {
        const next = [...prev];
        next[index] = '';
        return next;
      });
      return;
    }

    if (onlyDigits.length > 1) {
      const next = [...digits];
      for (let i = 0; i < onlyDigits.length && index + i < 6; i++) {
        next[index + i] = onlyDigits[i];
      }
      setDigits(next);
      const nextFocus = Math.min(5, index + onlyDigits.length);
      otpInputRefs.current[nextFocus]?.focus();
      return;
    }

    setDigits((prev) => {
      const next = [...prev];
      next[index] = onlyDigits;
      return next;
    });
    if (index < 5) {
      otpInputRefs.current[index + 1]?.focus();
    }
  };

  const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[index]) {
        setDigits((prev) => {
          const next = [...prev];
          next[index] = '';
          return next;
        });
      } else if (index > 0) {
        setDigits((prev) => {
          const next = [...prev];
          next[index - 1] = '';
          return next;
        });
        otpInputRefs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      otpInputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      otpInputRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setDigits(next);
    otpInputRefs.current[Math.min(5, pasted.length - 1)]?.focus();
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfoMsg('');
    const code = digits.join('');
    if (!/^\d{6}$/.test(code)) {
      setError('Please enter all 6 digits of the verification code sent to your email.');
      return;
    }

    setBusy(true);
    try {
      const result = await verifyCustomerOtp(email.trim().toLowerCase(), code);
      if (result.status === 'authenticated') {
        finishAuth(result.user?.role);
        return;
      }
      if (result.status === 'select_profile') {
        setProfiles(result.profiles || []);
        setStep('select_profile');
        return;
      }
      if (result.status === 'needs_registration') {
        setStep('register');
        return;
      }
    } catch (err: any) {
      setError(err?.message || 'OTP verification failed. Please check the code and try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectProfile = async (customerId: string) => {
    setError('');
    setBusy(true);
    try {
      const selectedUser = await selectCustomerProfile(customerId);
      finishAuth(selectedUser?.role);
    } catch (err: any) {
      setError(err?.message || 'Failed to open selected customer profile.');
    } finally {
      setBusy(false);
    }
  };

  const handleCompleteRegistration = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const cleanName = fullName.trim();
    const cleanMobile = mobile.trim();
    const cleanPin = pinCode.trim();

    if (!cleanName || cleanName.length < 2) {
      setError('Full Name is required (minimum 2 characters).');
      return;
    }
    if (!cleanMobile || !/^\+?\d{10,15}$/.test(cleanMobile.replace(/[\s()-]+/g, ''))) {
      setError('Please enter a valid 10-digit Mobile Number.');
      return;
    }
    if (cleanPin && !/^[0-9]{4,10}$/.test(cleanPin)) {
      setError('PIN Code must be 4 to 10 numeric digits.');
      return;
    }

    setBusy(true);
    try {
      const createdUser = await completeCustomerRegistration({
        fullName: cleanName,
        mobile: cleanMobile,
        companyOrCollege: companyOrCollege.trim(),
        fullAddress: fullAddress.trim(),
        city: city.trim(),
        state: stateName.trim(),
        pinCode: cleanPin,
      });
      finishAuth(createdUser?.role);
    } catch (err: any) {
      setError(err?.message || 'Unable to complete registration.');
    } finally {
      setBusy(false);
    }
  };

  const handleCustomerIdPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfoMsg('');
    const cleanId = customerIdInput.trim().toUpperCase();
    if (!cleanId) {
      setError('Please enter your Customer ID (e.g., NTF-CUST-000001).');
      return;
    }
    if (!customerPassword) {
      setError('Please enter your account password, or click "Send OTP to Linked Email".');
      return;
    }
    setBusy(true);
    try {
      const user = await signInWithCustomerId(cleanId, customerPassword);
      finishAuth(user?.role);
    } catch (err: any) {
      setError(err?.message || 'Unable to sign in with Customer ID.');
    } finally {
      setBusy(false);
    }
  };

  const handleCustomerIdOtpLookup = async () => {
    setError('');
    setInfoMsg('');
    const cleanId = customerIdInput.trim().toUpperCase();
    if (!cleanId) {
      setError('Please enter your Customer ID first (e.g., NTF-CUST-000001).');
      return;
    }
    setBusy(true);
    try {
      const resolved = await lookupCustomerId(cleanId);
      await sendCustomerOtp(resolved.email);
      setEmail(resolved.email);
      setDigits(['', '', '', '', '', '']);
      setStep('otp');
      setResendCooldown(30);
      setInfoMsg(
        `A 6-digit verification code has been sent to ${resolved.maskedEmail} linked with ${resolved.customerId}.`
      );
    } catch (err: any) {
      setError(err?.message || 'Unable to send OTP to linked email.');
    } finally {
      setBusy(false);
    }
  };

  const handleResetToEmail = () => {
    clearPendingOtpState();
    setDigits(['', '', '', '', '', '']);
    setError('');
    setInfoMsg('');
    setStep('email');
  };

  return (
    <div className={compact ? 'space-y-4' : 'space-y-5'}>
      <div className="space-y-1">
        <div className="text-[11px] font-mono font-bold tracking-widest uppercase text-[#1E88E5]">
          NEXUSTEKFUSION
        </div>
        <h2 className="font-display text-2xl font-bold text-[#123B5D]">
          {step === 'register'
            ? 'Complete Your Customer Profile'
            : step === 'select_profile'
            ? 'Select Customer Profile'
            : 'Welcome Back!'}
        </h2>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-900 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      {infoMsg && (
        <div className="rounded-xl border border-[#90CAF9] bg-[#F0F8FF] px-3.5 py-2.5 text-xs text-[#123B5D] flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-[#42A5F5] shrink-0 mt-0.5" />
          <span className="leading-relaxed">{infoMsg}</span>
        </div>
      )}

      {(step === 'email' || step === 'customer_id') && (
        <div className="grid grid-cols-2 rounded-xl border border-[#DCEAF5] bg-[#F0F8FF]/70 p-1 gap-1">
          <button
            type="button"
            onClick={() => {
              setError('');
              setInfoMsg('');
              setStep('email');
            }}
            className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all inline-flex items-center justify-center gap-1.5 ${
              step === 'email'
                ? 'bg-white text-[#123B5D] shadow-sm border border-[#DCEAF5]'
                : 'text-[#263746]/80 hover:text-[#123B5D]'
            }`}
          >
            <Mail className="w-3.5 h-3.5 text-[#1E88E5]" />
            Email OTP
          </button>
          <button
            type="button"
            onClick={() => {
              setError('');
              setInfoMsg('');
              setStep('customer_id');
            }}
            className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all inline-flex items-center justify-center gap-1.5 ${
              step === 'customer_id'
                ? 'bg-white text-[#123B5D] shadow-sm border border-[#DCEAF5]'
                : 'text-[#263746]/80 hover:text-[#123B5D]'
            }`}
          >
            <KeyRound className="w-3.5 h-3.5 text-[#1E88E5]" />
            Customer ID
          </button>
        </div>
      )}

      {step === 'email' && (
        <form onSubmit={handleSendOtp} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="otp-email-input" className="block text-xs font-semibold text-[#123B5D]">
              Email Address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-[#42A5F5] absolute left-3 top-3" />
              <input
                id="otp-email-input"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email address"
                className="w-full rounded-xl border border-[#DCEAF5] bg-white pl-9 pr-3 py-2.5 text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full py-3 bg-[#42A5F5] hover:bg-[#1E88E5] text-white text-sm font-semibold rounded-xl inline-flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Sending OTP...
              </>
            ) : (
              <>
                Send OTP
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>

          <p className="text-xs text-[#263746]/80 text-center leading-relaxed pt-1">
            Already have an account or new customer? Use the same OTP login process.
          </p>
        </form>
      )}

      {step === 'customer_id' && (
        <form onSubmit={handleCustomerIdPasswordLogin} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="customer-id-input" className="block text-xs font-semibold text-[#123B5D]">
              Customer ID
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-[#42A5F5] absolute left-3 top-3" />
              <input
                id="customer-id-input"
                type="text"
                required
                value={customerIdInput}
                onChange={(e) => setCustomerIdInput(e.target.value.toUpperCase())}
                placeholder="NTF-CUST-000001"
                className="w-full rounded-xl border border-[#DCEAF5] bg-white pl-9 pr-3 py-2.5 font-mono text-sm text-[#123B5D] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="customer-password-input" className="block text-xs font-semibold text-[#123B5D]">
              Password
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-[#42A5F5] absolute left-3 top-3" />
              <input
                id="customer-password-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={customerPassword}
                onChange={(e) => setCustomerPassword(e.target.value)}
                placeholder="Enter your password"
                className="w-full rounded-xl border border-[#DCEAF5] bg-white pl-9 pr-10 py-2.5 text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
              />
              <button
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-3 top-2.5 text-[#263746]/60 hover:text-[#123B5D]"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full py-3 bg-[#42A5F5] hover:bg-[#1E88E5] text-white text-sm font-semibold rounded-xl inline-flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Signing In...
              </>
            ) : (
              <>
                Sign In with Customer ID
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={handleCustomerIdOtpLookup}
            className="w-full py-2.5 border border-[#90CAF9] bg-[#F0F8FF]/60 hover:bg-[#E3F2FD] text-[#123B5D] text-xs font-semibold rounded-xl inline-flex items-center justify-center gap-1.5 disabled:opacity-50 transition-colors"
          >
            <Mail className="w-3.5 h-3.5 text-[#1E88E5]" />
            Haven&apos;t set a password? Verify via Linked Email OTP
          </button>
        </form>
      )}

      {step === 'otp' && (
        <form onSubmit={handleVerifyOtp} className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm text-[#263746]">
              Enter the 6-digit verification code sent to your email.
            </p>
            <div className="flex items-center justify-between text-xs text-[#123B5D]">
              <span className="font-mono font-semibold truncate">{email}</span>
              <button
                type="button"
                onClick={handleResetToEmail}
                className="text-[#1E88E5] hover:underline font-medium shrink-0 ml-2 inline-flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" /> Change email
              </button>
            </div>
          </div>

          <div className="grid grid-cols-6 gap-2 sm:gap-3" role="group" aria-label="6-digit OTP code">
            {digits.map((d, idx) => (
              <input
                key={idx}
                ref={(el) => {
                  otpInputRefs.current[idx] = el;
                }}
                type="text"
                inputMode="numeric"
                autoComplete={idx === 0 ? 'one-time-code' : 'off'}
                maxLength={6}
                aria-label={`OTP digit ${idx + 1}`}
                value={d}
                onChange={(e) => handleDigitChange(idx, e.target.value)}
                onKeyDown={(e) => handleDigitKeyDown(idx, e)}
                onPaste={handleOtpPaste}
                className="h-12 sm:h-13 w-full text-center font-mono text-lg font-bold text-[#123B5D] rounded-xl border border-[#90CAF9] bg-[#F0F8FF]/40 focus:bg-white focus:border-[#1E88E5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/30 transition-all"
              />
            ))}
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full py-3 bg-[#42A5F5] hover:bg-[#1E88E5] text-white text-sm font-semibold rounded-xl inline-flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Verifying...
              </>
            ) : (
              <>
                Verify &amp; Continue
                <ShieldCheck className="w-4 h-4" />
              </>
            )}
          </button>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              disabled={busy || resendCooldown > 0}
              onClick={() => handleSendOtp()}
              className="text-xs font-semibold text-[#123B5D] hover:text-[#1E88E5] disabled:text-[#263746]/45 inline-flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {resendCooldown > 0 ? `Resend OTP (${resendCooldown}s)` : 'Resend OTP'}
            </button>
          </div>
        </form>
      )}

      {step === 'select_profile' && (
        <div className="space-y-4">
          <p className="text-xs text-[#263746] leading-relaxed">
            Verified email <span className="font-mono font-semibold text-[#123B5D]">{email}</span> has multiple customer profiles. Choose which profile you want to open:
          </p>

          <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
            {profiles.map((p) => (
              <button
                key={p.customerId}
                type="button"
                disabled={busy}
                onClick={() => handleSelectProfile(p.customerId)}
                className="w-full text-left rounded-xl border border-[#DCEAF5] hover:border-[#42A5F5] hover:bg-[#F0F8FF]/60 p-3.5 transition-all flex items-center justify-between gap-3 disabled:opacity-50"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] font-bold text-[#1E88E5] bg-[#F0F8FF] border border-[#DCEAF5] px-2 py-0.5 rounded">
                      {p.customerId}
                    </span>
                    <span className="font-semibold text-sm text-[#123B5D] truncate">
                      {p.fullName || 'Customer Profile'}
                    </span>
                  </div>
                  <div className="text-xs text-[#263746]/80 flex flex-wrap gap-x-3 gap-y-0.5">
                    {p.mobile && <span className="font-mono">{p.mobile}</span>}
                    {p.companyOrCollege && <span>{p.companyOrCollege}</span>}
                    {(p.city || p.state) && (
                      <span>{[p.city, p.state].filter(Boolean).join(', ')}</span>
                    )}
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-[#42A5F5] shrink-0" />
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#DCEAF5]">
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep('register')}
              className="text-xs font-semibold text-[#1E88E5] hover:underline inline-flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Create New Customer Profile
            </button>
            <button
              type="button"
              onClick={handleResetToEmail}
              className="text-xs text-[#263746]/70 hover:text-[#123B5D]"
            >
              Use another email
            </button>
          </div>
        </div>
      )}

      {step === 'register' && (
        <form onSubmit={handleCompleteRegistration} className="space-y-3.5">
          <div className="rounded-xl border border-[#DCEAF5] bg-[#F0F8FF]/60 px-3.5 py-2.5 flex items-center justify-between text-xs">
            <span className="text-[#263746]">
              Verified Email: <strong className="font-mono text-[#123B5D]">{email}</strong>
            </span>
            <span className="font-mono text-[11px] font-semibold text-emerald-700">OTP Verified</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <label className="block text-xs font-semibold text-[#123B5D]">Full Name *</label>
              <div className="relative">
                <User className="w-4 h-4 text-[#42A5F5] absolute left-3 top-2.5" />
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Enter your full name"
                  className="w-full rounded-lg border border-[#DCEAF5] bg-white pl-9 pr-3 py-2 text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold text-[#123B5D]">Email Address</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-[#42A5F5] absolute left-3 top-2.5" />
                <input
                  type="email"
                  readOnly
                  value={email}
                  className="w-full rounded-lg border border-[#DCEAF5] bg-[#F0F8FF]/50 pl-9 pr-3 py-2 text-sm text-[#263746]/80 cursor-not-allowed"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold text-[#123B5D]">Mobile Number *</label>
              <div className="relative">
                <Phone className="w-4 h-4 text-[#42A5F5] absolute left-3 top-2.5" />
                <input
                  type="tel"
                  required
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  placeholder="10-digit mobile number"
                  className="w-full rounded-lg border border-[#DCEAF5] bg-white pl-9 pr-3 py-2 text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
                />
              </div>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <label className="block text-xs font-semibold text-[#123B5D]">Company / College</label>
              <div className="relative">
                <Building2 className="w-4 h-4 text-[#42A5F5] absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={companyOrCollege}
                  onChange={(e) => setCompanyOrCollege(e.target.value)}
                  placeholder="Organization, College, or Farm (Optional)"
                  className="w-full rounded-lg border border-[#DCEAF5] bg-white pl-9 pr-3 py-2 text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
                />
              </div>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <label className="block text-xs font-semibold text-[#123B5D]">Address</label>
              <div className="relative">
                <MapPin className="w-4 h-4 text-[#42A5F5] absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={fullAddress}
                  onChange={(e) => setFullAddress(e.target.value)}
                  placeholder="House / Flat, Street, Locality"
                  className="w-full rounded-lg border border-[#DCEAF5] bg-white pl-9 pr-3 py-2 text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold text-[#123B5D]">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="City"
                className="w-full rounded-lg border border-[#DCEAF5] bg-white px-3 py-2 text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-semibold text-[#123B5D]">State</label>
              <input
                type="text"
                value={stateName}
                onChange={(e) => setStateName(e.target.value)}
                placeholder="State"
                className="w-full rounded-lg border border-[#DCEAF5] bg-white px-3 py-2 text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <label className="block text-xs font-semibold text-[#123B5D]">PIN Code</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={10}
                value={pinCode}
                onChange={(e) => setPinCode(e.target.value)}
                placeholder="e.g. 440018"
                className="w-full rounded-lg border border-[#DCEAF5] bg-white px-3 py-2 font-mono text-sm text-[#263746] focus:border-[#42A5F5] focus:outline-none focus:ring-2 focus:ring-[#64B5F6]/20"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full py-3 bg-[#42A5F5] hover:bg-[#1E88E5] text-white text-sm font-semibold rounded-xl inline-flex items-center justify-center gap-2 disabled:opacity-50 transition-colors"
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving Profile...
              </>
            ) : (
              <>
                Save Profile &amp; Continue to Dashboard
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>

          {profiles.length > 0 && (
            <button
              type="button"
              onClick={() => setStep('select_profile')}
              className="w-full text-center text-xs font-semibold text-[#123B5D] hover:text-[#1E88E5] pt-1"
            >
              Back to Existing Profiles ({profiles.length})
            </button>
          )}
        </form>
      )}

      {(step === 'email' || step === 'customer_id') && (
        <div className="pt-2 border-t border-[#DCEAF5] text-center">
          <button
            type="button"
            onClick={() => {
              if (onComplete) onComplete('/admin/login');
              else navigate('/admin/login');
            }}
            className="text-[11px] text-[#263746]/70 hover:text-[#123B5D] underline-offset-2 hover:underline"
          >
            Administrator or staff? Use Admin Login
          </button>
        </div>
      )}
    </div>
  );
};
