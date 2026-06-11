import { prisma } from './src/lib/prisma.ts';
async function main() {
  const user = await prisma.user.findUnique({ where: { email: 'benedictmequiabas@gmail.com' }, include: { tokens: true } });
  console.log("USER:", user ? `Exists (Verified: ${user.emailVerified})` : "Not found");
  console.log("TOKENS:", user?.tokens);
}
main();
