const prisma = require("./lib/prisma");

async function purgeAllCustomerData() {
    console.log("Beginning complete purge of customer data...");

    const result = await prisma.$transaction(
        async (tx) => {
            const deletedSettlementItems = await tx.cashSettlementItem.deleteMany({});
            const deletedSettlements = await tx.cashSettlement.deleteMany({});
            const deletedOnlinePayments = await tx.onlinePayment.deleteMany({});
            const deletedCashCollections = await tx.cashCollection.deleteMany({});
            const deletedPayments = await tx.payment.deleteMany({});
            const deletedEmis = await tx.emiSchedule.deleteMany({});
            const deletedLoanAgentAssignments = await tx.loanAgentAssignment.deleteMany({});
            const deletedLoans = await tx.loan.deleteMany({});
            const deletedAppDocs = await tx.applicationDocument.deleteMany({});
            const deletedApps = await tx.loanApplication.deleteMany({});
            const deletedKycDocs = await tx.kycDocument.deleteMany({});
            const deletedCustAgentAssignments = await tx.customerAgentAssignment.deleteMany({});
            const deletedCustomerProfiles = await tx.customerProfile.deleteMany({});
            const deletedCustomerUsers = await tx.user.deleteMany({
                where: { role: "CUSTOMER" },
            });

            return {
                deletedSettlementItems: deletedSettlementItems.count,
                deletedSettlements: deletedSettlements.count,
                deletedOnlinePayments: deletedOnlinePayments.count,
                deletedCashCollections: deletedCashCollections.count,
                deletedPayments: deletedPayments.count,
                deletedEmis: deletedEmis.count,
                deletedLoanAgentAssignments: deletedLoanAgentAssignments.count,
                deletedLoans: deletedLoans.count,
                deletedAppDocs: deletedAppDocs.count,
                deletedApps: deletedApps.count,
                deletedKycDocs: deletedKycDocs.count,
                deletedCustAgentAssignments: deletedCustAgentAssignments.count,
                deletedCustomerProfiles: deletedCustomerProfiles.count,
                deletedCustomerUsers: deletedCustomerUsers.count,
            };
        },
        {
            timeout: 30000,
            maxWait: 10000,
        }
    );

    console.log("Customer data purge completed successfully:");
    console.table(result);

    // Verify remaining admin and agent accounts
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    const agentCount = await prisma.user.count({ where: { role: "AGENT" } });
    const customerCount = await prisma.user.count({ where: { role: "CUSTOMER" } });

    console.log("Current state of user accounts:");
    console.log({ adminCount, agentCount, customerCount });

    process.exit(0);
}

purgeAllCustomerData().catch((err) => {
    console.error("Purge failed:", err);
    process.exit(1);
});
