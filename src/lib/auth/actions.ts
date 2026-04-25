'use server';

import bcrypt from 'bcryptjs';
import { AuthError } from 'next-auth';
import { z } from 'zod';

import { signIn, signOut } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

const signupSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function signupAction(input: z.infer<typeof signupSchema>) {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' };
  }

  const { name, email, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { ok: false as const, error: 'email-taken' };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: { name, email, passwordHash },
  });

  try {
    await signIn('credentials', {
      email,
      password,
      redirect: false,
    });
    return { ok: true as const };
  } catch (error) {
    logger.error({ err: error }, 'signup-signin-failed');
    return { ok: true as const, requiresLogin: true };
  }
}

export async function loginAction(input: z.infer<typeof loginSchema>) {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid-input' };
  }

  try {
    await signIn('credentials', {
      ...parsed.data,
      redirect: false,
    });
    return { ok: true as const };
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false as const, error: error.type };
    }
    throw error;
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: '/' });
}
