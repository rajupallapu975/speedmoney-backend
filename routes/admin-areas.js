const express = require("express");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

// All area-management endpoints require an authenticated admin.
router.use(authenticateToken, authorizeRoles("ADMIN"));

/*
 * GET /api/admin/areas
 * List all collection areas.
 */
router.get("/", async (req, res) => {
    try {
        const areas = await prisma.area.findMany({
            include: {
                _count: {
                    select: {
                        agents: true,
                    },
                },
            },
            orderBy: {
                name: "asc",
            },
        });

        return res.json({
            success: true,
            count: areas.length,
            areas,
        });
    } catch (error) {
        console.error("List areas error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch areas",
        });
    }
});

/*
 * POST /api/admin/areas
 * Create a collection area.
 */
router.post("/", async (req, res) => {
    try {
        const { name, city, state, pincode } = req.body;

        if (typeof name !== "string" || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: "Area name is required",
            });
        }

        const normalizedName = name.trim();
        const normalizedCity =
            typeof city === "string" && city.trim()
                ? city.trim()
                : null;
        const normalizedState =
            typeof state === "string" && state.trim()
                ? state.trim()
                : null;
        const normalizedPincode =
            typeof pincode === "string" && pincode.trim()
                ? pincode.trim()
                : null;

        const existingArea = await prisma.area.findFirst({
            where: {
                name: normalizedName,
                city: normalizedCity,
                state: normalizedState,
            },
        });

        if (existingArea) {
            return res.status(409).json({
                success: false,
                message: "This area already exists",
            });
        }

        const area = await prisma.$transaction(async (tx) => {
            const createdArea = await tx.area.create({
                data: {
                    name: normalizedName,
                    city: normalizedCity,
                    state: normalizedState,
                    pincode: normalizedPincode,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "CREATE",
                    entity: "Area",
                    entityId: createdArea.id,
                    description: `Admin created collection area ${createdArea.name}`,
                },
            });

            return createdArea;
        });

        return res.status(201).json({
            success: true,
            message: "Collection area created successfully",
            area,
        });
    } catch (error) {
        console.error("Create area error:", error);

        if (error.code === "P2002") {
            return res.status(409).json({
                success: false,
                message: "An area with these details already exists",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to create collection area",
        });
    }
});

module.exports = router;