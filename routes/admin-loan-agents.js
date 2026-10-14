const express = require("express");

const prisma = require("../lib/prisma");
const { authenticateToken } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const router = express.Router();

// Every endpoint requires an authenticated administrator.
router.use(authenticateToken, authorizeRoles("ADMIN"));

/*
 * GET /api/admin/loan-agents
 *
 * List loan-agent assignments.
 *
 * Optional query parameters:
 * ?loanId=...
 * ?agentId=...
 * ?active=true
 */
router.get("/", async (req, res) => {
    try {
        const where = {};

        if (req.query.loanId) {
            where.loanId = String(req.query.loanId);
        }

        if (req.query.agentId) {
            where.agentId = String(req.query.agentId);
        }

        if (req.query.active !== undefined) {
            if (!["true", "false"].includes(req.query.active)) {
                return res.status(400).json({
                    success: false,
                    message: "active must be true or false",
                });
            }

            where.active = req.query.active === "true";
        }

        const assignments = await prisma.loanAgentAssignment.findMany({
            where,
            include: {
                loan: {
                    select: {
                        id: true,
                        loanNumber: true,
                        status: true,
                        customer: {
                            include: {
                                user: {
                                    select: {
                                        name: true,
                                        phone: true,
                                        email: true,
                                    },
                                },
                            },
                        },
                    },
                },
                agent: {
                    include: {
                        user: {
                            select: {
                                name: true,
                                email: true,
                                phone: true,
                                status: true,
                            },
                        },
                    },
                },
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
        console.error("List loan-agent assignments error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch loan-agent assignments",
        });
    }
});

/*
 * GET /api/admin/loan-agents/loans/:loanId
 *
 * Get assignments for a specific loan.
 */
router.get("/loans/:loanId", async (req, res) => {
    try {
        const loan = await prisma.loan.findUnique({
            where: {
                id: req.params.loanId,
            },
            select: {
                id: true,
                loanNumber: true,
                status: true,
            },
        });

        if (!loan) {
            return res.status(404).json({
                success: false,
                message: "Loan not found",
            });
        }

        const assignments = await prisma.loanAgentAssignment.findMany({
            where: {
                loanId: loan.id,
            },
            include: {
                agent: {
                    include: {
                        user: {
                            select: {
                                name: true,
                                email: true,
                                phone: true,
                                status: true,
                            },
                        },
                    },
                },
            },
            orderBy: {
                assignedAt: "desc",
            },
        });

        return res.json({
            success: true,
            loan,
            count: assignments.length,
            assignments,
        });
    } catch (error) {
        console.error("Fetch loan assignments error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch loan assignments",
        });
    }
});

/*
 * POST /api/admin/loan-agents
 *
 * Assign an agent to a loan.
 *
 * Request body:
 * {
 *   "loanId": "...",
 *   "agentId": "...",
 *   "type": "PRIMARY"
 * }
 *
 * type can be PRIMARY or BACKUP.
 */
router.post("/", async (req, res) => {
    try {
        const { loanId, agentId, type = "PRIMARY" } = req.body;

        if (!loanId || !agentId) {
            return res.status(400).json({
                success: false,
                message: "loanId and agentId are required",
            });
        }

        if (!["PRIMARY", "BACKUP"].includes(type)) {
            return res.status(400).json({
                success: false,
                message: "type must be PRIMARY or BACKUP",
            });
        }

        const [loan, agent] = await Promise.all([
            prisma.loan.findUnique({
                where: {
                    id: loanId,
                },
            }),
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
        ]);

        if (!loan) {
            return res.status(404).json({
                success: false,
                message: "Loan not found",
            });
        }

        if (loan.status === "PENDING_DISBURSEMENT") {
            return res.status(400).json({
                success: false,
                message: "Cannot assign agents to a loan that is pending disbursement",
            });
        }

        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found",
            });
        }

        if (agent.user.status !== "ACTIVE") {
            return res.status(400).json({
                success: false,
                message: "Only active agents can be assigned to loans",
            });
        }

        // Prevent duplicate active assignments of the same type.
        const existingAssignment =
            await prisma.loanAgentAssignment.findFirst({
                where: {
                    loanId,
                    agentId,
                    type,
                    active: true,
                },
            });

        if (existingAssignment) {
            return res.status(409).json({
                success: false,
                message: "This agent already has this active loan assignment",
            });
        }

        /*
         * Preserve assignment history.
         *
         * If an inactive record exists for the same agent, loan and type,
         * reactivate that record rather than creating a duplicate history
         * row with the same assignment.
         */
        const previousAssignment =
            await prisma.loanAgentAssignment.findFirst({
                where: {
                    loanId,
                    agentId,
                    type,
                    active: false,
                },
                orderBy: {
                    assignedAt: "desc",
                },
            });

        const assignment = await prisma.$transaction(async (tx) => {
            let created;

            if (previousAssignment) {
                created = await tx.loanAgentAssignment.update({
                    where: {
                        id: previousAssignment.id,
                    },
                    data: {
                        active: true,
                        assignedAt: new Date(),
                        unassignedAt: null,
                    },
                    include: {
                        loan: {
                            select: {
                                id: true,
                                loanNumber: true,
                                status: true,
                            },
                        },
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
                    },
                });
            } else {
                created = await tx.loanAgentAssignment.create({
                    data: {
                        loanId,
                        agentId,
                        type,
                        active: true,
                    },
                    include: {
                        loan: {
                            select: {
                                id: true,
                                loanNumber: true,
                                status: true,
                            },
                        },
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
                    },
                });
            }

            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "ASSIGN",
                    entity: "LoanAgentAssignment",
                    entityId: created.id,
                    description:
                        `Agent ${agent.employeeCode} assigned as ${type} ` +
                        `for loan ${loan.loanNumber}`,
                },
            });

            return created;
        });

        return res.status(201).json({
            success: true,
            message: "Agent assigned to loan successfully",
            assignment,
        });
    } catch (error) {
        console.error("Assign agent to loan error:", error);

        if (error.code === "P2002") {
            return res.status(409).json({
                success: false,
                message: "A conflicting assignment already exists",
            });
        }

        return res.status(500).json({
            success: false,
            message: "Failed to assign agent to loan",
        });
    }
});

/*
 * DELETE /api/admin/loan-agents/:assignmentId
 *
 * Deactivate an assignment while retaining its history.
 */
router.delete("/:assignmentId", async (req, res) => {
    try {
        const existing = await prisma.loanAgentAssignment.findUnique({
            where: {
                id: req.params.assignmentId,
            },
            include: {
                loan: {
                    select: {
                        loanNumber: true,
                    },
                },
                agent: {
                    select: {
                        employeeCode: true,
                    },
                },
            },
        });

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: "Assignment not found",
            });
        }

        if (!existing.active) {
            return res.status(409).json({
                success: false,
                message: "This assignment is already inactive",
            });
        }

        await prisma.$transaction(async (tx) => {
            await tx.loanAgentAssignment.update({
                where: {
                    id: existing.id,
                },
                data: {
                    active: false,
                    unassignedAt: new Date(),
                },
            });

            await tx.auditLog.create({
                data: {
                    userId: req.user.userId,
                    action: "UNASSIGN",
                    entity: "LoanAgentAssignment",
                    entityId: existing.id,
                    description:
                        `Agent ${existing.agent.employeeCode} unassigned from ` +
                        `loan ${existing.loan.loanNumber}`,
                },
            });
        });

        return res.json({
            success: true,
            message: "Agent unassigned from loan successfully",
        });
    } catch (error) {
        console.error("Unassign agent from loan error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to unassign agent",
        });
    }
});

module.exports = router;