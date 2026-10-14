const express = require("express");
const bcrypt = require("bcryptjs");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

// All agent-management endpoints require an administrator.
router.use(authenticateToken, authorizeRoles("ADMIN"));

/*
 * GET /api/admin/agents
 * List all agents.
 */
router.get("/", async (req, res) => {
    try {
        const agents = await prisma.agentProfile.findMany({
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        phone: true,
                        status: true,
                        createdAt: true,
                    },
                },
                areas: {
                    include: {
                        area: true,
                    },
                },
            },
            orderBy: {
                createdAt: "desc",
            },
        });

        return res.json({
            success: true,
            count: agents.length,
            agents,
        });
    } catch (error) {
        console.error("List agents error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch agents",
        });
    }
});

/*
 * POST /api/admin/agents
 * Create an agent account and profile.
 */
router.post("/", async (req, res) => {
    try {
        const {
            name,
            email,
            phone,
            password,
            employeeCode,
            address,
            city,
            state,
            joiningDate,
        } = req.body;

        if (!name || !email || !password || !employeeCode) {
            return res.status(400).json({
                success: false,
                message:
                    "Name, email, password and employeeCode are required",
            });
        }

        if (
            typeof password !== "string" ||
            password.length < 8
        ) {
            return res.status(400).json({
                success: false,
                message: "Password must contain at least 8 characters",
            });
        }

        if (
            typeof name !== "string" ||
            typeof email !== "string" ||
            typeof employeeCode !== "string"
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid name, email or employee code",
            });
        }

        const normalizedEmail = email.trim().toLowerCase();
        const normalizedEmployeeCode = employeeCode.trim();

        if (!normalizedEmail || !normalizedEmployeeCode) {
            return res.status(400).json({
                success: false,
                message: "Email and employee code cannot be empty",
            });
        }

        if (joiningDate && Number.isNaN(Date.parse(joiningDate))) {
            return res.status(400).json({
                success: false,
                message: "Invalid joining date",
            });
        }

        const existingUser = await prisma.user.findFirst({
            where: {
                OR: [
                    { email: normalizedEmail },
                    ...(phone
                        ? [{ phone: String(phone).trim() }]
                        : []),
                ],
            },
        });

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: "Email or phone number is already registered",
            });
        }

        const existingAgent = await prisma.agentProfile.findUnique({
            where: {
                employeeCode: normalizedEmployeeCode,
            },
        });

        if (existingAgent) {
            return res.status(409).json({
                success: false,
                message: "Employee code is already registered",
            });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        const agent = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
                data: {
                    name: name.trim(),
                    email: normalizedEmail,
                    phone: phone ? String(phone).trim() : null,

                    // Your Prisma schema uses `password`.
                    password: hashedPassword,

                    role: "AGENT",
                    status: "ACTIVE",
                },
            });

            const profile = await tx.agentProfile.create({
                data: {
                    userId: user.id,
                    employeeCode: normalizedEmployeeCode,
                    address: address || null,
                    city: city || null,
                    state: state || null,
                    joiningDate: joiningDate
                        ? new Date(joiningDate)
                        : null,
                },
            });

            // Your Prisma schema uses `entity`, not `entityType`.
            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "CREATE",
                    entity: "AgentProfile",
                    entityId: profile.id,
                    description: `Admin created agent ${normalizedEmployeeCode}`,
                },
            });

            return {
                id: profile.id,
                employeeCode: profile.employeeCode,
                joiningDate: profile.joiningDate,
                address: profile.address,
                city: profile.city,
                state: profile.state,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    role: user.role,
                    status: user.status,
                },
            };
        });

        return res.status(201).json({
            success: true,
            message: "Agent created successfully",
            agent,
        });
    } catch (error) {
        console.error("Create agent error:", error);

        if (error.code === "P2002") {
            return res.status(409).json({
                success: false,
                message: "Email, phone or employee code already exists",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to create agent",
        });
    }
});

/*
 * PATCH /api/admin/agents/:id/status
 * Activate, deactivate or suspend an agent.
 */
router.patch("/:id/status", async (req, res) => {
    try {
        const { status } = req.body;

        if (!["ACTIVE", "INACTIVE", "SUSPENDED"].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Status must be ACTIVE, INACTIVE or SUSPENDED",
            });
        }

        const agent = await prisma.agentProfile.findUnique({
            where: {
                id: req.params.id,
            },
        });

        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found",
            });
        }

        const updatedAgent = await prisma.$transaction(async (tx) => {
            const updatedUser = await tx.user.update({
                where: {
                    id: agent.userId,
                },
                data: {
                    status,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "UPDATE",
                    entity: "AgentProfile",
                    entityId: agent.id,
                    description: `Agent status changed to ${status}`,
                },
            });

            return updatedUser;
        });

        return res.json({
            success: true,
            message: "Agent status updated successfully",
            agent: {
                id: agent.id,
                employeeCode: agent.employeeCode,
                user: {
                    id: updatedAgent.id,
                    name: updatedAgent.name,
                    email: updatedAgent.email,
                    status: updatedAgent.status,
                },
            },
        });
    } catch (error) {
        console.error("Update agent status error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to update agent status",
        });
    }
});

/*
 * DELETE /api/admin/agents/:id
 * Remove a field agent account, assignments, and associated agent profile.
 */
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;

        const agent = await prisma.agentProfile.findFirst({
            where: {
                OR: [{ id }, { userId: id }],
            },
            include: {
                user: true,
                collections: true,
            },
        });

        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found",
            });
        }

        await prisma.$transaction(
            async (tx) => {
                const collectionIds = agent.collections.map((c) => c.id);
                if (collectionIds.length > 0) {
                    await tx.cashSettlementItem.deleteMany({
                        where: { cashCollectionId: { in: collectionIds } },
                    });
                    await tx.cashCollection.deleteMany({
                        where: { id: { in: collectionIds } },
                    });
                }

                // Nullify agent reference on settlements if any
                await tx.cashSettlement.updateMany({
                    where: { agentId: agent.id },
                    data: { agentId: null },
                });

                // Delete loan & customer agent assignments
                await tx.loanAgentAssignment.deleteMany({
                    where: { agentId: agent.id },
                });
                await tx.customerAgentAssignment.deleteMany({
                    where: { agentId: agent.id },
                });
                await tx.agentArea.deleteMany({
                    where: { agentId: agent.id },
                });

                // Delete profile & user
                await tx.agentProfile.delete({
                    where: { id: agent.id },
                });
                await tx.user.delete({
                    where: { id: agent.userId },
                });

                // Log audit
                await tx.auditLog.create({
                    data: {
                        userId: req.user.userId,
                        action: "DELETE",
                        entity: "AgentProfile",
                        entityId: agent.id,
                        description: `Admin removed agent ${agent.employeeCode} (${agent.user?.name || ""})`,
                    },
                });
            },
            {
                timeout: 30000,
                maxWait: 10000,
            }
        );

        return res.json({
            success: true,
            message: `Agent ${agent.user?.name || agent.employeeCode} removed successfully`,
        });
    } catch (err) {
        console.error("Delete agent error:", err);
        return res.status(500).json({
            success: false,
            message: err.message || "Failed to remove agent",
        });
    }
});

module.exports = router;