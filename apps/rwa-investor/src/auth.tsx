import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";

interface AuthUser {
  name: string;
  email: string;
}

interface AuthValue {
  user: AuthUser;
  getIdToken: () => Promise<string>;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth must be used inside AuthGate");
  return auth;
}

function createPool(): CognitoUserPool | null {
  const UserPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
  const ClientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
  return UserPoolId && ClientId ? new CognitoUserPool({ UserPoolId, ClientId }) : null;
}

function sessionUser(session: CognitoUserSession): AuthUser {
  const claims = session.getIdToken().payload;
  const name = `${String(claims.given_name || "")} ${String(claims.family_name || "")}`.trim();
  return {
    name: name || String(claims.email || "Investor"),
    email: String(claims.email || ""),
  };
}

function sessionFor(pool: CognitoUserPool): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const current = pool.getCurrentUser();
    if (!current) return reject(new Error("No active Cognito session"));
    current.getSession((error: Error | null, session: CognitoUserSession | null) => {
      if (error || !session?.isValid()) reject(error || new Error("Session expired"));
      else resolve(session);
    });
  });
}

export function AuthGate({ children }: { children: ReactNode }) {
  const pool = useMemo(createPool, []);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!pool) {
      setChecking(false);
      return;
    }
    sessionFor(pool).then((session) => setUser(sessionUser(session))).catch(() => undefined)
      .finally(() => setChecking(false));
  }, [pool]);

  if (checking) return <AccessShell title="Validating your invitation…" />;
  if (!pool) {
    return (
      <AuthContext.Provider
        value={{
          user: { name: "Fixture investor", email: "local fixture" },
          getIdToken: async () => "",
          signOut: () => undefined,
        }}
      >
        {children}
      </AuthContext.Provider>
    );
  }
  if (!user) return <SignIn pool={pool} onAuthenticated={setUser} />;

  return (
    <AuthContext.Provider
      value={{
        user,
        getIdToken: async () => (await sessionFor(pool)).getIdToken().getJwtToken(),
        signOut: () => {
          pool.getCurrentUser()?.signOut();
          setUser(null);
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

function SignIn({
  pool,
  onAuthenticated,
}: {
  pool: CognitoUserPool;
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pending, setPending] = useState<CognitoUser | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const complete = (session: CognitoUserSession) => {
    setBusy(false);
    onAuthenticated(sessionUser(session));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    if (pending) {
      pending.completeNewPasswordChallenge(newPassword, {}, {
        onSuccess: complete,
        onFailure: (reason) => {
          setBusy(false);
          setError(reason.message || "Account activation failed");
        },
      });
      return;
    }
    const cognitoUser = new CognitoUser({ Username: email.trim(), Pool: pool });
    cognitoUser.authenticateUser(
      new AuthenticationDetails({ Username: email.trim(), Password: password }),
      {
        onSuccess: complete,
        onFailure: (reason) => {
          setBusy(false);
          setError(reason.message || "Sign-in failed");
        },
        newPasswordRequired: () => {
          setBusy(false);
          setPending(cognitoUser);
        },
      },
    );
  };

  return (
    <div className="access-page">
      <div className="access-mark" aria-hidden="true">T</div>
      <form className="access-card" onSubmit={submit}>
        <span className="eyebrow">INVITATION-ONLY REGISTRY</span>
        <ShieldCheck size={34} strokeWidth={1.4} />
        <h1>{pending ? "Activate your account" : "Investor access"}</h1>
        <p>
          {pending
            ? "Replace your temporary password to complete activation."
            : "Use the Cognito invitation issued to your investor record."}
        </p>
        {pending ? (
          <label>
            Permanent password
            <input
              type="password"
              minLength={12}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
        ) : (
          <>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          </>
        )}
        {error ? <div className="form-error">{error}</div> : null}
        <button type="submit" disabled={busy}>
          <KeyRound size={16} />
          {busy ? "Verifying…" : pending ? "Activate" : "Enter registry"}
          <ArrowRight size={16} />
        </button>
      </form>
    </div>
  );
}

function AccessShell({ title }: { title: string }) {
  return (
    <div className="access-page">
      <div className="access-card access-loading">
        <span className="pulse-dot" />
        <h1>{title}</h1>
      </div>
    </div>
  );
}
