require("dotenv").config();

const bcrypt = require("bcryptjs");
const prisma = require("./lib/prisma");

async function seedAdmin() {
    const adminEmail = "admin@loanplatform.com";
    const adminPhone = "9000000000";
    const adminPassword = "Admin@12345";

    try {
        const existingAdmin = await prisma.user.findUnique({
            where: {
                email: adminEmail,
            },
        });

        const hashedPassword = await bcrypt.hash(adminPassword, 12);
        if (existingAdmin) {
            await prisma.user.update({
                where: { id: existingAdmin.id },
                data: { password: hashedPassword, role: "ADMIN", status: "ACTIVE" },
            });
            console.log("Admin account password updated to Admin@12345.");
            return;
        }

        const admin = await prisma.user.create({
            data: {
                name: "Platform Admin",
                email: adminEmail,
                phone: adminPhone,
                password: hashedPassword,
                role: "ADMIN",
                status: "ACTIVE",
            },
        });

        console.log("ADMIN CREATED SUCCESSFULLY");
        console.log("Email:", admin.email);
        console.log("Role:", admin.role);
    } catch (error) {
        console.error("ADMIN CREATION FAILED");
        console.error(error);
    } finally {
        await prisma.$disconnect();
    }
}

seedAdmin();