/**
 * Middleware — gates the /admin area using the edge-safe Auth.js config.
 * Unauthenticated requests to /admin/* (except the login page) are redirected
 * to /admin/login by the `authorized` callback in src/auth.config.ts.
 */
import NextAuth from 'next-auth';

import { authConfig } from '@/auth.config';

export default NextAuth(authConfig).auth;

export const config = {
  matcher: ['/admin/:path*'],
};
