/**
 * Module augmentation: add a `role` to the Auth.js user/session/JWT types so the
 * commissioner role is strongly typed throughout the app (no `any` casts).
 */
import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface User {
    role?: string;
  }
  interface Session {
    user: {
      role?: string;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role?: string;
  }
}
