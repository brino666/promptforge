import { useState } from "react";
import "./auth.css";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <a href="/" className="auth-logo">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="28" height="28" rx="7" fill="#c17a5a" />
              <path d="M8 9h12M8 14h8M8 19h10" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Thais
          </a>
        </div>
        <h1>Welcome back</h1>
        <p className="auth-subtitle">Sign in to your private workspace</p>
        {/* Sign in form would go here */}
      </div>
    </div>
  );
}