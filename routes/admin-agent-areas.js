const express = require("express");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

// All endpoints require an authenticated administrator.
router.use(authenticateToken, authorizeRoles("ADMIN"));

/*
 * GET /api/admin/agent-areas
 * List agent-area assignments.
 */
router.get("/", async (req, res) => {
    try {
        const assignments = await prisma.agentArea.findMany({
            include: {
                agent: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                phone: true,
                                status: true,
                            },
                        },
                    },
                },
                area: true,
            },
            orderBy: {
                assignedAt: "desc",
            },
        });

        return res.json({
            success: true,
            count: assignments.length,
            assignments,
        });
    } catch (error) {
        console.error("List agent-area assignments error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch agent-area assignments",
        });
    }
});

/*
 * GET /api/admin/agent-areas/agents/:agentId
 * List areas assigned to a particular agent.
 */
router.get("/agents/:agentId", async (req, res) => {
    try {
        const agent = await prisma.agentProfile.findUnique({
            where: {
                id: req.params.agentId,
            },
            select: {
                id: true,
                employeeCode: true,
                user: {
                    select: {
                        name: true,
                        email: true,
                        status: true,
                    },
                },
            },
        });

        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found",
            });
        }

        const assignments = await prisma.agentArea.findMany({
            where: {
                agentId: agent.id,
            },
            include: {
                area: true,
            },
            orderBy: {
                assignedAt: "desc",
            },
        });

        return res.json({
            success: true,
            agent,
            count: assignments.length,
            assignments,
        });
    } catch (error) {
        console.error("Fetch agent areas error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch agent areas",
        });
    }
});

/*
 * POST /api/admin/agent-areas
 * Assign an agent to an area.
 *
 * Request body:
 * {
 *   "agentId": "...",
 *   "areaId": "..."
 * }
 */
router.post("/", async (req, res) => {
    try {
        const { agentId, areaId } = req.body;

        if (!agentId || !areaId) {
            return res.status(400).json({
                success: false,
                message: "agentId and areaId are required",
            });
        }

        const [agent, area] = await Promise.all([
            prisma.agentProfile.findUnique({
                where: {
                    id: agentId,
                },
                include: {
                    user: {
                        select: {
                            status: true,
                        },
                    },
                },
            }),
            prisma.area.findUnique({
                where: {
                    id: areaId,
                },
            }),
        ]);

        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found",
            });
        }

        if (agent.user.status !== "ACTIVE") {
            return res.status(400).json({
                success: false,
                message: "Only active agents can be assigned to areas",
            });
        }

        if (!area) {
            return res.status(404).json({
                success: false,
                message: "Area not found",
            });
        }

        const assignment = await prisma.$transaction(async (tx) => {
            const created = await tx.agentArea.create({
                data: {
                    agentId,
                    areaId,
                },
                include: {
                    agent: {
                        include: {
                            user: {
                                select: {
                                    name: true,
                                    email: true,
                                    status: true,
                                },
                            },
                        },
                    },
                    area: true,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "ASSIGN",
                    entity: "AgentArea",
                    entityId: created.id,
                    description: `Agent ${agent.employeeCode} assigned to area ${area.name}`,
                },
            });

            return created;
        });

        return res.status(201).json({
            success: true,
            message: "Agent assigned to area successfully",
            assignment,
        });
    } catch (error) {
        console.error("Assign agent to area error:", error);

        if (error.code === "P2002") {
            return res.status(409).json({
                success: false,
                message: "This agent is already assigned to this area",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to assign agent to area",
        });
    }
});

/*
 * DELETE /api/admin/agent-areas/:assignmentId
 * Remove an agent-area assignment.
 */
router.delete("/:assignmentId", async (req, res) => {
    try {
        const existing = await prisma.agentArea.findUnique({
            where: {
                id: req.params.assignmentId,
            },
            include: {
                agent: true,
                area: true,
            },
        });

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Agent-area assignment not found",
            });
        }

        await prisma.$transaction(async (tx) => {
            await tx.agentArea.delete({
                where: {
                    id: existing.id,
                },
            });

            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "UNASSIGN",
                    entity: "AgentArea",
                    entityId: existing.id,
                    description: `Agent ${existing.agent.employeeCode} removed from area ${existing.area.name}`,
                },
            });
        });

        return res.json({
            success: true,
            message: "Agent removed from area successfully",
        });
    } catch (error) {
        console.error("Remove agent-area assignment error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to remove agent-area assignment",
        });
    }
});

module.exports = router;