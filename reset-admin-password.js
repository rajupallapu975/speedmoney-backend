
require("dotenv").config();

const bcrypt = require("bcryptjs");
const prisma = require("./lib/prisma");

async function resetAdminPassword() {
    try {
        const email = process.env.ADMIN_RESET_EMAIL
            ?.trim()
            .toLowerCase();

        const newPassword = process.env.ADMIN_RESET_PASSWORD;

        if (!email || !newPassword || newPassword.length < 12) {
            throw new Error(
                "Admin email and a password of at least 12 characters are required."
            );
        }

        const user = await prisma.user.findUnique({
            where: { email },
        });

        if (!user) {
            console.log(
                "No account found for this email. No changes were made."
            );
            return;
        }

        if (user.role !== "ADMIN") {
            console.log(
                "This account is not an administrator. No changes were made."
            );
            return;
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await prisma.user.update({
            where: { id: user.id },
            data: { password: hashedPassword },
        });

        console.log("Admin password reset successfully.");
        console.log("You can now log in with your new password.");
    } catch (error) {
        console.error("Password reset failed:", error.message);
        process.exitCode = 1;
    } finally {
        await prisma.$disconnect();
    }
}

resetAdminPassword();
