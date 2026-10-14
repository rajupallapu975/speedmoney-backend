const prisma = require("./lib/prisma");

async function testDatabase() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log("DATABASE CONNECTION OK");
  } catch (error) {
    console.error("DATABASE CONNECTION FAILED");
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

testDatabase();