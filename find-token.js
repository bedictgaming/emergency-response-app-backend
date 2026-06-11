import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const token = await prisma.token.findFirst({ where: { type: 'EMAIL_VERIFY', user: { email: 'bedictsabaiuqem@gmail.com' } } });
  console.log(token);
}
main();
