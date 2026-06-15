/**
 * Auth.js HTTP handlers (sign-in, sign-out, session, callbacks).
 * Runs on the Node.js runtime because the credentials provider uses bcrypt.
 */
import { handlers } from '@/auth';

export const runtime = 'nodejs';
export const { GET, POST } = handlers;
