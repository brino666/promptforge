import { useState, useEffect, useCallback } from "react";
import {
  loadStripe,
  Elements,
  CardNumberElement,
  CardExpiryElement,
  CardCvcElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import "./subscription.css";

// ─── Stripe loader (call once, outside component) ────────────────────────────
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

// ─── Plan definitions (prices must match Stripe dashboard) ───────────────────
const PLANS = [
  {
    id: "starter",
    priceId: import.meta.env.VITE_STRIPE_PRICE_STARTER,
    name: "Starter",
    tagline: "For curious builders",
    price: 9,
    interval: "month",
    features: [
      "500 prompt generations / mo",
      "3 custom templates",
      "Basic analytics",
      "Community support",
    ],
    cta: "Start building",
    accent: "#4ECDC4",
  },
  {
    id: "pro",
    priceId: import.meta.env.VITE_STRIPE_PRICE_PRO,
    name: "Pro",
    tagline: "For power users",
    price: 29,
    interval: "month",
    popular: true,
    features: [
      "Unlimited prompt generations",
      "Unlimited custom templates",
      "Advanced analytics & exports",
      "Priority email support",
      "API access (10k calls/mo)",
      "Team sharing (up to 3)",
    ],
    cta: "Go Pro",
    accent: "#FF6B6B",
  },
  {
    id: "team",
    priceId: import.meta.env.VITE_STRIPE_PRICE_TEAM,
    name: "Team",
    tagline: "For scaling teams",
    price: 79,
    interval: "month",
    features: [
      "Everything in Pro",
      "Unlimited API access",
      "SSO & advanced security",
      "Dedicated Slack support",
      "Custom integrations",
      "Unlimited team members",
    ],
    cta: "Scale up",
    accent: "#C084FC",
  },
];

// ─── Stripe card element options ─────────────────────────────────────────────
const CARD_STYLE = {
  style: {
    base: {
      color: "#F0ECE3",
      fontFamily: "'DM Mono', monospace",
      fontSize: "15px",
      fontSmoothing: "antialiased",
      "::placeholder": { color: "#5A5650" },
      letterSpacing: "0.02em",
    },
    invalid: { color: "#FF6B6B", iconColor: "#FF6B6B" },
  },
};

// ─── Checkout form (inside <Elements>) ───────────────────────────────────────
function CheckoutForm({ plan, onSuccess, onCancel }) {
  const stripe = useStripe();
  const elements = useElements();

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [coupon, setCoupon] = useState("");
  const [couponStatus, setCouponStatus] = useState(null); // null | "checking" | {valid, discount} | "error"
  const [errors, setErrors] = useState({});
  const [cardComplete, setCardComplete] = useState({
    number: false,
    expiry: false,
    cvc: false,
  });
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState("");

  // Validate coupon on blur
  const handleCouponBlur = async () => {
    if (!coupon.trim()) return;
    setCouponStatus("checking");
    try {
      const res = await fetch("/api/validate-coupon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coupon: coupon.trim() }),
      });
      const data = await res.json();
      setCouponStatus(data.valid ? data : "error");
    } catch {
      setCouponStatus("error");
    }
  };

  // Client-side validation
  const validate = () => {
    const errs = {};
    if (!name.trim()) errs.name = "Name is required";
    if (!email.trim()) errs.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      errs.email = "Enter a valid email address";
    if (!cardComplete.number) errs.cardNumber = "Card number is incomplete";
    if (!cardComplete.expiry) errs.cardExpiry = "Expiry is incomplete";
    if (!cardComplete.cvc) errs.cardCvc = "CVC is incomplete";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setApiError("");
    if (!stripe || !elements || !validate()) return;

    setLoading(true);
    try {
      // 1. Create Stripe PaymentMethod
      const cardNumberEl = elements.getElement(CardNumberElement);
      const { error: pmError, paymentMethod } =
        await stripe.createPaymentMethod({
          type: "card",
          card: cardNumberEl,
          billing_details: { name, email },
        });
      if (pmError) throw new Error(pmError.message);

      // 2. Create subscription on backend
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name,
          paymentMethodId: paymentMethod.id,
          priceId: plan.priceId,
          coupon: coupon.trim() || undefined,
        }),
      });
      const subData = await res.json();
      if (!res.ok) throw new Error(subData.error || "Subscription failed");

      // 3. Handle 3DS / additional auth if needed
      if (
        subData.status === "incomplete" &&
        subData.clientSecret
      ) {
        const { error: confirmError } =
          await stripe.confirmCardPayment(subData.clientSecret);
        if (confirmError) throw new Error(confirmError.message);
      }

      onSuccess({ email, plan, subscriptionId: subData.subscriptionId });
    } catch (err) {
      setApiError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="checkout-overlay">
      <div className="checkout-drawer">
        {/* Header */}
        <div className="checkout-header">
          <div>
            <span className="checkout-badge" style={{ background: plan.accent + "22", color: plan.accent }}>
              {plan.name} plan
            </span>
            <h2 className="checkout-title">Complete your subscription</h2>
            <p className="checkout-price">
              <span className="price-big">${plan.price}</span>
              <span className="price-interval"> / {plan.interval}</span>
            </p>
          </div>
          <button className="icon-btn" onClick={onCancel} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {/* Personal info */}
          <fieldset className="field-group">
            <legend className="field-legend">Account details</legend>
            <div className={`field-wrap ${errors.name ? "field-error" : ""}`}>
              <label className="field-label" htmlFor="name">Full name</label>
              <input
                id="name"
                className="field-input"
                type="text"
                autoComplete="name"
                placeholder="Alex Johnson"
                value={name}
                onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: "" })); }}
              />
              {errors.name && <span className="field-msg">{errors.name}</span>}
            </div>

            <div className={`field-wrap ${errors.email ? "field-error" : ""}`}>
              <label className="field-label" htmlFor="email">Email address</label>
              <input
                id="email"
                className="field-input"
                type="email"
                autoComplete="email"
                placeholder="alex@company.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: "" })); }}
              />
              {errors.email && <span className="field-msg">{errors.email}</span>}
            </div>
          </fieldset>

          {/* Card details */}
          <fieldset className="field-group">
            <legend className="field-legend">
              Payment details
              <span className="secure-badge">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1L2 2.5V6c0 2.2 1.7 4.3 4 4.9 2.3-.6 4-2.7 4-4.9V2.5L6 1z" fill="currentColor" />
                </svg>
                Secured by Stripe
              </span>
            </legend>

            <div className={`field-wrap ${errors.cardNumber ? "field-error" : ""}`}>
              <label className="field-label">Card number</label>
              <div className="stripe-wrap">
                <CardNumberElement
                  options={{ ...CARD_STYLE, showIcon: true }}
                  onChange={(e) => {
                    setCardComplete((p) => ({ ...p, number: e.complete }));
                    if (e.error) setErrors((p) => ({ ...p, cardNumber: e.error.message }));
                    else setErrors((p) => ({ ...p, cardNumber: "" }));
                  }}
                />
              </div>
              {errors.cardNumber && <span className="field-msg">{errors.cardNumber}</span>}
            </div>

            <div className="field-row">
              <div className={`field-wrap ${errors.cardExpiry ? "field-error" : ""}`}>
                <label className="field-label">Expiry</label>
                <div className="stripe-wrap">
                  <CardExpiryElement
                    options={CARD_STYLE}
                    onChange={(e) => {
                      setCardComplete((p) => ({ ...p, expiry: e.complete }));
                      if (e.error) setErrors((p) => ({ ...p, cardExpiry: e.error.message }));
                      else setErrors((p) => ({ ...p, cardExpiry: "" }));
                    }}
                  />
                </div>
                {errors.cardExpiry && <span className="field-msg">{errors.cardExpiry}</span>}
              </div>

              <div className={`field-wrap ${errors.cardCvc ? "field-error" : ""}`}>
                <label className="field-label">CVC</label>
                <div className="stripe-wrap">
                  <CardCvcElement
                    options={CARD_STYLE}
                    onChange={(e) => {
                      setCardComplete((p) => ({ ...p, cvc: e.complete }));
                      if (e.error) setErrors((p) => ({ ...p, cardCvc: e.error.message }));
                      else setErrors((p) => ({ ...p, cardCvc: "" }));
                    }}
                  />
                </div>
                {errors.cardCvc && <span className="field-msg">{errors.cardCvc}</span>}
              </div>
            </div>
          </fieldset>

          {/* Coupon */}
          <fieldset className="field-group">
            <legend className="field-legend">Promo code <span className="optional">(optional)</span></legend>
            <div className="coupon-row">
              <input
                className={`field-input coupon-input ${couponStatus === "error" ? "field-error" : couponStatus?.valid ? "field-success" : ""}`}
                type="text"
                placeholder="FORGE20"
                value={coupon}
                onChange={(e) => { setCoupon(e.target.value); setCouponStatus(null); }}
                onBlur={handleCouponBlur}
              />
              {couponStatus === "checking" && <span className="coupon-spinner" />}
              {couponStatus?.valid && (
                <span className="coupon-ok">✓ {couponStatus.discount}% off</span>
              )}
              {couponStatus === "error" && (
                <span className="coupon-err">Invalid code</span>
              )}
            </div>
          </fieldset>

          {/* API error */}
          {apiError && (
            <div className="api-error" role="alert">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" stroke="#FF6B6B" strokeWidth="1.5" />
                <path d="M8 4.5v4M8 11h.01" stroke="#FF6B6B" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              {apiError}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            className="submit-btn"
            disabled={!stripe || loading}
            style={{ "--accent": plan.accent }}
          >
            {loading ? (
              <span className="btn-spinner" />
            ) : (
              <>
                Subscribe · ${plan.price}/{plan.interval}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </>
            )}
          </button>

          <p className="checkout-legal">
            By subscribing you agree to our{" "}
            <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a> and{" "}
            <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
            Cancel anytime from your account settings.
          </p>
        </form>
      </div>
    </div>
  );
}

// ─── Success screen ───────────────────────────────────────────────────────────
function SuccessScreen({ data, onManage }) {
  return (
    <div className="result-screen success-screen">
      <div className="result-icon success-icon">
        <svg viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="30" cy="30" r="29" stroke="#4ECDC4" strokeWidth="2" />
          <path d="M18 30l8 8 16-16" stroke="#4ECDC4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 className="result-title">You're in.</h2>
      <p className="result-sub">
        Welcome to PromptForge <strong>{data.plan.name}</strong>. A confirmation
        has been sent to <strong>{data.email}</strong>.
      </p>
      <div className="result-actions">
        <a href="/app" className="result-btn primary-btn">
          Go to PromptForge →
        </a>
        <button className="result-btn ghost-btn" onClick={onManage}>
          Manage subscription
        </button>
      </div>
    </div>
  );
}

// ─── Plan card ────────────────────────────────────────────────────────────────
function PlanCard({ plan, selected, onSelect }) {
  return (
    <div
      className={`plan-card ${selected ? "plan-selected" : ""} ${plan.popular ? "plan-popular" : ""}`}
      style={{ "--card-accent": plan.accent }}
      onClick={() => onSelect(plan)}
    >
      {plan.popular && <div className="popular-tag">Most popular</div>}
      <div className="plan-header">
        <h3 className="plan-name">{plan.name}</h3>
        <p className="plan-tagline">{plan.tagline}</p>
        <div className="plan-price">
          <span className="plan-amount">${plan.price}</span>
          <span className="plan-interval">/{plan.interval}</span>
        </div>
      </div>
      <ul className="plan-features">
        {plan.features.map((f) => (
          <li key={f}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 7l3.5 3.5L12 3" stroke={plan.accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {f}
          </li>
        ))}
      </ul>
      <button
        className="plan-btn"
        onClick={(e) => { e.stopPropagation(); onSelect(plan); }}
        aria-label={`Select ${plan.name} plan`}
      >
        {plan.cta}
      </button>
    </div>
  );
}

// ─── Testimonials ─────────────────────────────────────────────────────────────
const TESTIMONIALS = [
  {
    quote: "We cut our prompt iteration time in half. What used to take a full afternoon now takes 20 minutes.",
    name: "Jamie K.",
    role: "Lead Engineer",
    company: "Stackable",
    initials: "JK",
    accent: "#FF6B6B",
    stars: 5,
  },
  {
    quote: "The template system is a game changer. My whole team is on the same page for the first time.",
    name: "Priya M.",
    role: "AI Product Manager",
    company: "Loopline",
    initials: "PM",
    accent: "#4ECDC4",
    stars: 5,
  },
  {
    quote: "I tried three other tools before this. PromptForge is the only one that actually fits how I think.",
    name: "Carlos R.",
    role: "Indie Hacker",
    company: "Self-employed",
    initials: "CR",
    accent: "#C084FC",
    stars: 5,
  },
  {
    quote: "Onboarded 8 engineers in a day. The API access on Pro is exactly what we needed to automate our pipeline.",
    name: "Dana W.",
    role: "CTO",
    company: "Meridian Labs",
    initials: "DW",
    accent: "#FF6B6B",
    stars: 5,
  },
  {
    quote: "Finally a tool that doesn't get in my way. Clean, fast, and the analytics actually tell me something useful.",
    name: "Theo B.",
    role: "Freelance Developer",
    company: "Freelance",
    initials: "TB",
    accent: "#4ECDC4",
    stars: 5,
  },
  {
    quote: "Customer support replied in under 2 hours on a Sunday. That alone is worth the Pro subscription.",
    name: "Amara J.",
    role: "Growth Lead",
    company: "Verdant",
    initials: "AJ",
    accent: "#C084FC",
    stars: 5,
  },
];

function StarRating({ count }) {
  return (
    <div className="star-rating" aria-label={`${count} out of 5 stars`}>
      {Array.from({ length: count }).map((_, i) => (
        <svg key={i} width="13" height="13" viewBox="0 0 13 13" fill="#FF6B6B">
          <path d="M6.5 1l1.5 3.1 3.4.5-2.5 2.4.6 3.4L6.5 9 3 10.4l.6-3.4L1.1 4.6l3.4-.5L6.5 1z" />
        </svg>
      ))}
    </div>
  );
}

function TestimonialCard({ testimonial: t }) {
  return (
    <div className="testimonial-card" style={{ "--t-accent": t.accent }}>
      <StarRating count={t.stars} />
      <p className="testimonial-quote">"{t.quote}"</p>
      <div className="testimonial-author">
        <div className="testimonial-avatar" style={{ background: t.accent + "18", borderColor: t.accent + "33", color: t.accent }}>
          {t.initials}
        </div>
        <div>
          <div className="testimonial-name">{t.name}</div>
          <div className="testimonial-role">{t.role} · {t.company}</div>
        </div>
      </div>
    </div>
  );
}

// ─── FAQ accordion ────────────────────────────────────────────────────────────
const FAQ_ITEMS = [
  {
    q: "Can I cancel at any time?",
    a: "Yes — cancel from your account settings before the next billing cycle and you won't be charged again. You'll keep access until the period ends.",
  },
  {
    q: "What happens when I hit a usage limit?",
    a: "We'll notify you at 80% and 100% usage. You can upgrade at any time or purchase additional generation credits.",
  },
  {
    q: "Is there a free trial?",
    a: "Every plan includes a 7-day free trial. No charge until the trial ends, and you can cancel before then with no obligation.",
  },
  {
    q: "Can I switch plans later?",
    a: "Absolutely. Upgrades take effect immediately (prorated). Downgrades take effect at the next billing cycle.",
  },
  {
    q: "Do you offer annual pricing?",
    a: "Yes — annual billing saves you 20%. Contact sales@promptforge.ai for an annual invoice.",
  },
];

function FaqItem({ item }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`faq-item ${open ? "faq-open" : ""}`}>
      <button className="faq-q" onClick={() => setOpen(!open)}>
        {item.q}
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="faq-icon">
          <path d="M4 7l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <div className="faq-a">{item.a}</div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SubscriptionPage() {
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [showCheckout, setShowCheckout] = useState(false);
  const [successData, setSuccessData] = useState(null);
  const [portalLoading, setPortalLoading] = useState(false);

  // Read ?plan=pro from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const planParam = params.get("plan");
    if (planParam) {
      const found = PLANS.find((p) => p.id === planParam);
      if (found) { setSelectedPlan(found); setShowCheckout(true); }
    }
  }, []);

  const handleSelectPlan = useCallback((plan) => {
    setSelectedPlan(plan);
    setShowCheckout(true);
  }, []);

  const handleSuccess = useCallback((data) => {
    setShowCheckout(false);
    setSuccessData(data);
  }, []);

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/customer-portal", { method: "POST" });
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      alert("Unable to open billing portal. Please try again.");
    } finally {
      setPortalLoading(false);
    }
  };

  return (
    <div className="page">
      {/* ── Nav ─────────────────────────────── */}
      <nav className="nav">
        <a href="/" className="logo">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="7" fill="#FF6B6B" />
            <path d="M8 9h12M8 14h8M8 19h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          </svg>
          PromptForge
        </a>
        <div className="nav-links">
          <a href="/docs">Docs</a>
          <a href="/blog">Blog</a>
          {successData ? (
            <button
              className="nav-cta"
              onClick={handleManageSubscription}
              disabled={portalLoading}
            >
              {portalLoading ? "Loading…" : "Manage plan"}
            </button>
          ) : (
            <>
              <a href="/signin" className="nav-signin">Sign in</a>
              <a
                href="#plans"
                className="nav-cta"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById("plans")?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Sign up free →
              </a>
            </>
          )}
        </div>
      </nav>

      <main>
        {successData ? (
          <SuccessScreen data={successData} onManage={handleManageSubscription} />
        ) : (
          <>
            {/* ── Hero ──────────────────────────── */}
            <section className="hero">
              <div className="hero-eyebrow">Simple, transparent pricing</div>
              <h1 className="hero-title">
                Forge better prompts.<br />
                <span className="title-gradient">Ship faster.</span>
              </h1>
              <p className="hero-sub">
                Every plan includes a 7-day free trial. No credit card required to start.
              </p>
              <div className="trial-pill">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="6" stroke="#4ECDC4" strokeWidth="1.5" />
                  <path d="M7 4v3.5l2 1.5" stroke="#4ECDC4" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                7-day free trial · Cancel anytime · No hidden fees
              </div>
            </section>

            {/* ── Plans ─────────────────────────── */}
            <section id="plans" className="plans-section" aria-label="Subscription plans">
              <div className="plans-grid">
                {PLANS.map((plan) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    selected={selectedPlan?.id === plan.id}
                    onSelect={handleSelectPlan}
                  />
                ))}
              </div>
            </section>

            {/* ── Trust bar ─────────────────────── */}
            <section className="trust-bar">
              <div className="trust-item">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <path d="M11 2L4 5v6c0 4 3 7.7 7 8.9 4-1.2 7-4.9 7-8.9V5L11 2z" stroke="#4ECDC4" strokeWidth="1.5" fill="none" />
                </svg>
                <span>256-bit SSL encryption</span>
              </div>
              <div className="trust-item">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <rect x="3" y="7" width="16" height="12" rx="2" stroke="#4ECDC4" strokeWidth="1.5" />
                  <path d="M7 7V5a4 4 0 018 0v2" stroke="#4ECDC4" strokeWidth="1.5" />
                </svg>
                <span>PCI-DSS compliant via Stripe</span>
              </div>
              <div className="trust-item">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <circle cx="11" cy="11" r="9" stroke="#4ECDC4" strokeWidth="1.5" />
                  <path d="M7 11l3 3 5-5" stroke="#4ECDC4" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span>SOC 2 Type II certified</span>
              </div>
              <div className="trust-item">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <path d="M2 11h18M11 2c-4 3-6 6-6 9s2 6 6 9c4-3 6-6 6-9s-2-6-6-9z" stroke="#4ECDC4" strokeWidth="1.5" />
                </svg>
                <span>GDPR & CCPA ready</span>
              </div>
            </section>

            {/* ── Testimonials ──────────────────── */}
            <section className="testimonials-section">
              <div className="testimonials-header">
                <div className="testimonials-eyebrow">What people are saying</div>
                <h2 className="section-title">Builders love PromptForge</h2>
              </div>
              <div className="testimonials-grid">
                {TESTIMONIALS.map((t) => (
                  <TestimonialCard key={t.name} testimonial={t} />
                ))}
              </div>
            </section>

            {/* ── FAQ ───────────────────────────── */}
            <section className="faq-section">
              <h2 className="section-title">Frequently asked</h2>
              <div className="faq-list">
                {FAQ_ITEMS.map((item) => (
                  <FaqItem key={item.q} item={item} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      {/* ── Checkout drawer ─────────────────── */}
      {showCheckout && selectedPlan && (
        <Elements stripe={stripePromise}>
          <CheckoutForm
            plan={selectedPlan}
            onSuccess={handleSuccess}
            onCancel={() => setShowCheckout(false)}
          />
        </Elements>
      )}

      <footer className="footer">
        <span>© {new Date().getFullYear()} PromptForge Inc.</span>
        <span>
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="mailto:support@promptforge.ai">Support</a>
        </span>
      </footer>
    </div>
  );
}
