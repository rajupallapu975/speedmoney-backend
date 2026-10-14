const prisma = require("./prisma");

/**
 * Robustly resolves the CustomerProfile for a JWT authenticated user.
 * 
 * Handles:
 * 1. Direct match on userId.
 * 2. User exists but CustomerProfile record is missing -> auto-creates profile.
 * 3. Token contains stale/purged userId from a reseeded database -> falls back to phone number match.
 * 4. Falls back to email match if present.
 * 5. Returns null if user is completely unknown, enabling endpoints to respond with HTTP 401.
 */
async function getResolvedCustomerProfile(reqUser) {
    if (!reqUser) return null;
    const userId = reqUser.userId || reqUser.id;

    if (userId) {
        // 1. Direct CustomerProfile lookup by userId
        try {
            const profile = await prisma.customerProfile.findUnique({
                where: { userId },
                include: { user: true },
            });
            if (profile) return profile;
        } catch (e) {
            console.warn("[getResolvedCustomerProfile] findUnique by userId failed:", e.message);
        }

        // 2. Check if user exists by userId
        try {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                include: { customerProfile: true },
            });
            if (user) {
                if (user.customerProfile) return user.customerProfile;
                return await prisma.customerProfile.create({
                    data: { userId: user.id },
                    include: { user: true },
                });
            }
        } catch (e) {
            console.warn("[getResolvedCustomerProfile] findUnique User failed:", e.message);
        }
    }

    // 3. Fallback: Lookup by phone if available in reqUser
    const rawPhone = reqUser.phone;
    if (rawPhone) {
        const cleanPhone = String(rawPhone).replace(/\D/g, "").slice(-10);
        if (cleanPhone.length === 10) {
            try {
                const userByPhone = await prisma.user.findFirst({
                    where: {
                        OR: [
                            { phone: cleanPhone },
                            { phone: `+91${cleanPhone}` },
                            { phone: `91${cleanPhone}` },
                        ],
                    },
                    include: { customerProfile: true },
                });
                if (userByPhone) {
                    if (userByPhone.customerProfile) return userByPhone.customerProfile;
                    return await prisma.customerProfile.create({
                        data: { userId: userByPhone.id },
                        include: { user: true },
                    });
                }
            } catch (e) {
                console.warn("[getResolvedCustomerProfile] findFirst by phone failed:", e.message);
            }
        }
    }

    // 4. Fallback: Lookup by email if available in reqUser
    if (reqUser.email) {
        try {
            const userByEmail = await prisma.user.findUnique({
                where: { email: reqUser.email },
                include: { customerProfile: true },
            });
            if (userByEmail) {
                if (userByEmail.customerProfile) return userByEmail.customerProfile;
                return await prisma.customerProfile.create({
                    data: { userId: userByEmail.id },
                    include: { user: true },
                });
            }
        } catch (e) {
            console.warn("[getResolvedCustomerProfile] findUnique by email failed:", e.message);
        }
    }

    return null;
}

module.exports = { getResolvedCustomerProfile };
