/**
 * Disbursement Proof Storage Service
 * 
 * Enforces strict durable private storage requirements for loan disbursement:
 * 1. Checks readiness exclusively through trusted server-side configuration and an operational storage adapter.
 * 2. Does NOT treat environment variables alone (e.g., bucket name) as proof of storage readiness.
 * 3. Never accepts client-supplied overrides or arbitrary public URLs / local filesystem paths as proof.
 * 4. Fails closed (HTTP 503) whenever private cloud storage is not configured and operational.
 * 5. Returns a verified storage reference ONLY after durable persistence is confirmed by a trusted adapter.
 */

// Active server-side storage adapter (null by default in production until configured)
let activeStorageAdapter = null;

/**
 * Register a trusted private storage adapter.
 * Adapter must implement:
 * - isAvailable(): boolean
 * - storeProof({ fileData, fileName, mimeType, loanId }): Promise<{ storageReference: string, storedAt: Date }>
 */
function registerStorageAdapter(adapter) {
    if (adapter && typeof adapter.isAvailable === "function" && typeof adapter.storeProof === "function") {
        activeStorageAdapter = adapter;
    } else {
        throw new Error("Invalid storage adapter: must implement isAvailable() and storeProof()");
    }
}

/**
 * Reset adapter (for teardown in tests or reconfiguration).
 */
function resetStorageAdapter() {
    activeStorageAdapter = null;
}

/**
 * Check whether durable proof storage is fully operational.
 * A bucket name environment variable alone does NOT establish readiness.
 * Readiness requires an instantiated, operational storage adapter.
 */
function isProofStorageReady() {
    if (!activeStorageAdapter) {
        return false;
    }
    try {
        return Boolean(activeStorageAdapter.isAvailable());
    } catch {
        return false;
    }
}

/**
 * Validates disbursement proof and uploads it to durable private storage via the active adapter.
 * 
 * Rejects:
 * - Calls when storage is not configured / adapter unavailable (fails closed with 503).
 * - Client-supplied public URLs, arbitrary keys, or local filesystem paths.
 * - Missing or invalid proof evidence.
 * 
 * @param {Object} proofPayload - Proof evidence to store { content, fileName, mimeType }
 * @param {string} loanId - Target loan identifier
 * @returns {Promise<{ verified: boolean, storageReference: string, storedAt: Date }>}
 */
async function verifyAndStoreDisbursementProof(proofPayload, loanId) {
    // 1. Fail closed if private storage adapter is not operational
    if (!isProofStorageReady()) {
        const error = new Error(
            "Durable private proof storage is not configured. Disbursement activation is disabled until a secure storage adapter is operational."
        );
        error.code = "STORAGE_NOT_CONFIGURED";
        error.statusCode = 503;
        throw error;
    }

    // 2. Proof payload must exist
    if (!proofPayload) {
        const error = new Error("Disbursement proof evidence is required");
        error.statusCode = 400;
        throw error;
    }

    // 3. Reject plain string references, public URLs, and local filesystem paths
    // Transfer evidence must be actual uploadable evidence or verified file data, not an unverified string.
    if (typeof proofPayload === "string") {
        const str = proofPayload.trim();

        // Reject local paths (e.g., C:\..., /tmp/...)
        if (/^([a-zA-Z]:\\|\/|file:\/\/)/i.test(str)) {
            const error = new Error(
                "Local filesystem paths cannot be accepted as disbursement proof. Verifiable durable storage is required."
            );
            error.statusCode = 400;
            throw error;
        }

        // Reject arbitrary public internet URLs
        if (/^https?:\/\//i.test(str)) {
            const error = new Error(
                "Arbitrary public URLs cannot be accepted as disbursement proof. Evidence must be uploaded through the trusted storage adapter."
            );
            error.statusCode = 400;
            throw error;
        }

        // Reject bare string keys
        const error = new Error(
            "Arbitrary string identifiers cannot be accepted as proof. Verifiable proof file data is required."
        );
        error.statusCode = 400;
        throw error;
    }

    // 4. Validate proof file data structure
    const { fileBuffer, base64Content, fileName, mimeType } = proofPayload;

    if (!fileBuffer && !base64Content) {
        const error = new Error(
            "Disbursement proof file content (buffer or base64) is required for durable storage."
        );
        error.statusCode = 400;
        throw error;
    }

    const allowedMimeTypes = [
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/webp",
    ];

    if (mimeType && !allowedMimeTypes.includes(mimeType.toLowerCase())) {
        const error = new Error(
            `Invalid proof document type '${mimeType}'. Allowed formats: PDF, PNG, JPEG, WEBP.`
        );
        error.statusCode = 400;
        throw error;
    }

    // 5. Delegate actual durable persistence to the operational adapter
    let storageResult;
    try {
        storageResult = await activeStorageAdapter.storeProof({
            fileData: fileBuffer || Buffer.from(base64Content, "base64"),
            fileName: fileName || `disbursement-${loanId}-${Date.now()}`,
            mimeType: mimeType || "application/pdf",
            loanId,
        });
    } catch (adapterErr) {
        const error = new Error(
            `Proof storage failed: ${adapterErr.message || "Adapter upload error"}`
        );
        error.statusCode = adapterErr.statusCode || 500;
        error.code = adapterErr.code || "STORAGE_UPLOAD_FAILED";
        throw error;
    }

    if (!storageResult || !storageResult.storageReference) {
        const error = new Error(
            "Storage provider did not confirm successful persistence of proof evidence."
        );
        error.statusCode = 500;
        error.code = "STORAGE_PERSISTENCE_UNCONFIRMED";
        throw error;
    }

    return {
        verified: true,
        storageReference: storageResult.storageReference,
        storedAt: storageResult.storedAt || new Date(),
    };
}

module.exports = {
    isProofStorageReady,
    registerStorageAdapter,
    resetStorageAdapter,
    verifyAndStoreDisbursementProof,
};
