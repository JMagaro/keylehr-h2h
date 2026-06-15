import type { Metadata } from 'next';
import Link from 'next/link';

import { Card, CardBody } from '@/components/card';

import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Admin sign in',
  robots: { index: false },
};

export default function AdminLoginPage() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <Link href="/" className="text-sm font-semibold tracking-tight text-accent">
            KeyLehr H2H
          </Link>
          <h1 className="mt-2 text-xl font-semibold text-foreground">Commissioner sign in</h1>
          <p className="mt-1 text-sm text-muted">Admin access to manage the league.</p>
        </div>
        <Card>
          <CardBody>
            <LoginForm />
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
