/**
 * Edge-safe Auth.js configuration.
 *
 * This half of the config contains NO Node-only code (no bcrypt, no DB), so it
 * can run in middleware on the edge runtime. The full config (with the
 * Credentials provider) lives in `src/auth.ts` and is used by the API route.
 *
 * See the Auth.js v5 "split config" pattern.
 */
import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
  // Trust the deployment host (Vercel sets this automatically, but being explicit
  // avoids URL/callback issues behind the proxy and on custom domains).
  trustHost: true,
  pages: {
    signIn: '/admin/login',
  },
  session: { strategy: 'jwt' },
  providers: [], // real providers are added in src/auth.ts
  callbacks: {
    /**
     * Route protection used by middleware. Gate everything under /admin except
     * the login page itself. Returning false redirects to the `signIn` page.
     */
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const isLogin = pathname === '/admin/login';
      const isAdminArea = pathname.startsWith('/admin');
      if (isLogin) return true;
      if (isAdminArea) return Boolean(auth?.user);
      return true;
    },
    jwt({ token, user }) {
      if (user) token.role = user.role ?? 'admin';
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.role === 'string') {
        session.user.role = token.role;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
