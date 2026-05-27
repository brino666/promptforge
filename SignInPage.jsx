import { useState } from "react";
import "./auth.css";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState("");

  const validate = () => {
    const errs = {};
    if (!email.trim()) errs.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      errs.email = "Enter a valid email";
    if (!password) errs.password = "Password is required";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setApiError("");
    if (!validate()) return;
    setLoading(true);
    try {
      // TODO: replace with your real auth endpoint
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      // On success — redirect to dashboard
      window.location.href = "/app";
    } catch (err) {
      setApiError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* Background grid */}
      <div className="auth-grid" aria-hidden="true" />

      {/* Nav */}
      <nav className="auth-nav">
        <a href="/" className="auth-logo">
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="7" fill="#FF6B6B" />
            <path d="M8 9h12M8 14h8M8 19h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          </svg>
          PromptForge
        </a>
        <span className="auth-nav-hint">
          No account?{" "}
          <a href="/pricing" className="auth-link">Start free trial →</a>
        </span>
      </nav>

      {/* Card */}
      <div className="auth-card-wrap">
        <div className="auth-card">
          {/* Header */}
          <div className="auth-card-header">
            <div className="auth-icon-mark">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 2a4 4 0 100 8 4 4 0 000-8zM4 18a6 6 0 0112 0" stroke="#FF6B6B" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            </div>
            <h1 className="auth-title">Welcome back</h1>
            <p className="auth-subtitle">Sign in to your PromptForge account</p>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            {/* Email */}
            <div className={`auth-field ${errors.email ? "auth-field-error" : ""}`}>
              <label className="auth-label" htmlFor="email">Email address</label>
              <input
                id="email"
                className="auth-input"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setErrors(p => ({...p, email: ""})); }}
              />
              {errors.email && <span className="auth-field-msg">{errors.email}</span>}
            </div>

            {/* Password */}
            <div className={`auth-field ${errors.password ? "auth-field-error" : ""}`}>
              <div className="auth-label-row">
                <label className="auth-label" htmlFor="password">Password</label>
                <a href="/forgot-password" className="auth-forgot">Forgot password?</a>
              </div>
              <div className="auth-input-wrap">
                <input
                  id="password"
                  className="auth-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setErrors(p => ({...p, password: ""})); }}
                />
                <button
                  type="button"
                  className="auth-eye"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M2 2l12 12M6.5 6.6A2 2 0 0010 9.4M3 7.5C4.2 5.5 5.9 4 8 4c.7 0 1.4.2 2 .5M13.4 9.8C12.2 11.2 10.2 12 8 12c-2 0-3.9-.8-5.2-2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M8 4C5.8 4 3.8 5.3 2.5 7.5 3.8 9.7 5.8 11 8 11s4.2-1.3 5.5-3.5C12.2 5.3 10.2 4 8 4z" stroke="currentColor" strokeWidth="1.3"/>
                      <circle cx="8" cy="7.5" r="1.5" stroke="currentColor" strokeWidth="1.3"/>
                    </svg>
                  )}
                </button>
              </div>
              {errors.password && <span className="auth-field-msg">{errors.password}</span>}
            </div>

            {/* API error */}
            {apiError && (
              <div className="auth-error" role="alert">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="6" stroke="#FF6B6B" strokeWidth="1.4"/>
                  <path d="M7 4v3.5M7 9.5h.01" stroke="#FF6B6B" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
                {apiError}
              </div>
            )}

            {/* Submit */}
            <button type="submit" className="auth-submit-btn" disabled={loading}>
              {loading ? <span className="auth-spinner" /> : "Sign in to PromptForge"}
            </button>
          </form>

          {/* Divider */}
          <div className="auth-divider"><span>or</span></div>

          {/* Sign up CTA — prominent, not buried */}
          <a href="/pricing" className="auth-signup-cta">
            <span>Create a new account</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </a>

          <p className="auth-legal">
            By signing in you agree to our{" "}
            <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.
          </p>
        </div>

        {/* Side trust note */}
        <div className="auth-trust">
          <div className="trust-quote">
            "PromptForge cut our prompt iteration time in half."
          </div>
          <div className="trust-author">
            <div className="trust-avatar">JK</div>
            <div>
              <div className="trust-name">Jamie K.</div>
              <div className="trust-role">Lead Engineer, Stackable</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
