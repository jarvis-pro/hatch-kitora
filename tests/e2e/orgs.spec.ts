import { expect, test } from './fixtures/test';
import {
  createOrgWithOwner,
  createTestUser,
  deleteOrg,
  deleteUser,
  issueOrgInvitationToken,
} from './fixtures/db';

test.describe('organizations', () => {
  test('invitee accepts invitation, switches into org, sees billing', async ({ page, signIn }) => {
    // Owner + non-personal org "acme".
    const owner = await createTestUser({ emailVerified: true });
    const org = await createOrgWithOwner({ ownerId: owner.id, slug: `acme-${Date.now()}` });

    // Invitee already exists with email-verified.
    const invitee = await createTestUser({ emailVerified: true });

    const rawToken = await issueOrgInvitationToken({
      orgId: org.id,
      email: invitee.email,
      role: 'MEMBER',
      invitedBy: owner.id,
    });

    try {
      // Invitee signs in first.
      await signIn(page, invitee);

      // Visit the invite link → accept page should render with the org name.
      await page.goto(`/invite/${rawToken}`);
      await expect(page.getByRole('button', { name: /accept invitation/i })).toBeVisible();
      await page.getByRole('button', { name: /accept invitation/i }).click();

      // After accepting we land on /dashboard.
      await page.waitForURL(/\/dashboard/);

      // Org switcher should now offer the new org. Open it and pick acme.
      await page.getByRole('button', { name: /workspace/i }).click();
      await page.getByRole('menuitem', { name: org.name }).click();
      // Wait for the page to refresh into the new org context.
      await page.waitForLoadState('networkidle');

      // Members nav item should now be visible (hidden in personal orgs).
      await expect(page.getByRole('link', { name: /members/i })).toBeVisible();

      // Billing page loads under the new org context (Free plan, no subscription).
      await page.goto('/dashboard/billing');
      await expect(page.getByRole('heading', { name: /billing/i })).toBeVisible();
    } finally {
      await deleteOrg(org.id);
      await deleteUser(invitee.id);
      await deleteUser(owner.id);
    }
  });

  test('invalid invitation token shows error page', async ({ page }) => {
    await page.goto('/invite/this-is-not-a-real-tokenXXXXXXXXXXXXX');
    await expect(page.getByRole('heading', { name: /invalid invitation/i })).toBeVisible();
  });
});
