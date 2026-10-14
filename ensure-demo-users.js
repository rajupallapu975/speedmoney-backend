require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('./lib/prisma');

async function ensureDemoUsers() {
  console.log('Ensuring demo users are ready...');

  // 1. Admin: admin@loanplatform.com / Admin@12345
  const adminPw = await bcrypt.hash('Admin@12345', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@loanplatform.com' },
    update: { password: adminPw, status: 'ACTIVE', role: 'ADMIN' },
    create: {
      name: 'Platform Admin',
      email: 'admin@loanplatform.com',
      phone: '9000000000',
      password: adminPw,
      role: 'ADMIN',
      status: 'ACTIVE'
    }
  });
  console.log('Admin ready:', admin.email);

  // 2. Customer: testcustomer@example.com / TestPassword123!
  const custPw = await bcrypt.hash('TestPassword123!', 12);
  const cust = await prisma.user.upsert({
    where: { email: 'testcustomer@example.com' },
    update: { password: custPw, status: 'ACTIVE', role: 'CUSTOMER' },
    create: {
      name: 'Test Customer',
      email: 'testcustomer@example.com',
      phone: '9000000001',
      password: custPw,
      role: 'CUSTOMER',
      status: 'ACTIVE',
      customerProfile: { create: {} }
    }
  });
  console.log('Customer ready:', cust.email);

  // 3. Agent: agent.test.002@loanplatform.com / Agent@12345
  const agentPw = await bcrypt.hash('Agent@12345', 12);
  const agentUser = await prisma.user.upsert({
    where: { email: 'agent.test.002@loanplatform.com' },
    update: { password: agentPw, status: 'ACTIVE', role: 'AGENT' },
    create: {
      name: 'Test Collection Agent',
      email: 'agent.test.002@loanplatform.com',
      phone: '9000000002',
      password: agentPw,
      role: 'AGENT',
      status: 'ACTIVE'
    }
  });

  // Ensure AgentProfile exists
  const existingProfile = await prisma.agentProfile.findUnique({
    where: { userId: agentUser.id }
  });

  if (!existingProfile) {
    await prisma.agentProfile.create({
      data: {
        userId: agentUser.id,
        employeeCode: 'AGT-002',
        status: 'ACTIVE'
      }
    });
  }
  console.log('Agent ready:', agentUser.email);
}

ensureDemoUsers()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
