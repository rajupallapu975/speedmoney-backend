
require("dotenv").config();

const bcrypt = require("bcryptjs");
const prisma = require("./lib/prisma");

async function resetAgentPassword() {
    try {
        const email = process.env.AGENT_RESET_EMAIL
            ?.trim()
            .toLowerCase();

        const newPassword = process.env.AGENT_RESET_PASSWORD;

        if (!email || !newPassword || newPassword.length < 12) {
            throw new Error(
                "Agent email and a password of at least 12 characters are required."
            );
        }

        const user = await prisma.user.findUnique({
            where: { email },
            include: { agentProfile: true },
        });

        if (!user || user.role !== "AGENT" || !user.agentProfile) {
            console.log(
                "Agent account not found. No changes were made."
            );
            return;
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await prisma.user.update({
            where: { id: user.id },
            data: { password: hashedPassword },
        });

        console.log("Agent password reset successfully.");
        console.log("Employee code:", user.agentProfile.employeeCode);
    } catch (error) {
        console.error("Agent password reset failed:", error.message);
        process.exitCode = 1;
    } finally {
        await prisma.$disconnect();
    }
}

resetAgentPassword();

