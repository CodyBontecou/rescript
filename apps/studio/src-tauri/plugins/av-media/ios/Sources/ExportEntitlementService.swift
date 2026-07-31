import Foundation
import StoreKit

struct ExportEntitlementState: Codable {
    let enforcement: String
    let entitled: Bool
    let productId: String
    let displayPrice: String?
    let canPurchase: Bool
}

struct ExportPurchaseResult: Codable {
    let outcome: String
    let entitlement: ExportEntitlementState
}

enum ExportEntitlementError: LocalizedError {
    case operationInProgress
    case productUnavailable
    case invalidProductType
    case verificationFailed(String)
    case invalidTransaction

    var errorDescription: String? {
        switch self {
        case .operationInProgress:
            return "Another App Store operation is already in progress."
        case .productUnavailable:
            return "Unlimited Exports is not available from the App Store right now. Please try again."
        case .invalidProductType:
            return "Unlimited Exports is not configured as a one-time purchase."
        case .verificationFailed(let message):
            return "The App Store could not verify this purchase: \(message)"
        case .invalidTransaction:
            return "The App Store returned a purchase that does not unlock Unlimited Exports."
        }
    }
}

@available(iOS 16.0, *)
actor ExportEntitlementService {
    static let productId = "tech.isolated.rescript.unlimited_exports"

    private var cachedProduct: Product?
    private var operationInProgress = false
    private var updatesTask: Task<Void, Never>?

    deinit {
        updatesTask?.cancel()
    }

    func status() async -> ExportEntitlementState {
        let product = try? await loadProduct()
        let entitled = await hasCurrentEntitlement()
        return ExportEntitlementState(
            enforcement: "storeKit",
            entitled: entitled,
            productId: Self.productId,
            displayPrice: product?.displayPrice,
            canPurchase: product != nil
        )
    }

    func isEntitled() async -> Bool {
        await hasCurrentEntitlement()
    }

    func purchase() async throws -> ExportPurchaseResult {
        guard !operationInProgress else {
            throw ExportEntitlementError.operationInProgress
        }
        operationInProgress = true
        defer { operationInProgress = false }

        let current = await status()
        if current.entitled {
            return ExportPurchaseResult(
                outcome: "alreadyEntitled",
                entitlement: current
            )
        }

        let product = try await loadProduct()
        let result = try await product.purchase()
        switch result {
        case .success(let verification):
            let transaction = try verifiedTransaction(from: verification)
            guard isValidEntitlement(transaction) else {
                throw ExportEntitlementError.invalidTransaction
            }
            await transaction.finish()
            return ExportPurchaseResult(
                outcome: "purchased",
                entitlement: await status()
            )
        case .pending:
            return ExportPurchaseResult(
                outcome: "pending",
                entitlement: await status()
            )
        case .userCancelled:
            return ExportPurchaseResult(
                outcome: "cancelled",
                entitlement: await status()
            )
        @unknown default:
            return ExportPurchaseResult(
                outcome: "cancelled",
                entitlement: await status()
            )
        }
    }

    func restore() async throws -> ExportPurchaseResult {
        guard !operationInProgress else {
            throw ExportEntitlementError.operationInProgress
        }
        operationInProgress = true
        defer { operationInProgress = false }

        try await AppStore.sync()
        let current = await status()
        return ExportPurchaseResult(
            outcome: current.entitled ? "restored" : "notFound",
            entitlement: current
        )
    }

    func startObserving(
        onChange: @escaping @Sendable (ExportEntitlementState) -> Void
    ) {
        guard updatesTask == nil else { return }
        updatesTask = Task { [weak self] in
            for await verification in Transaction.updates {
                guard !Task.isCancelled else { break }
                guard case .verified(let transaction) = verification,
                      transaction.productID == Self.productId else {
                    continue
                }
                await transaction.finish()
                guard let self else { break }
                onChange(await self.status())
            }
        }
    }

    private func loadProduct() async throws -> Product {
        if let cachedProduct { return cachedProduct }
        let products = try await Product.products(for: [Self.productId])
        guard let product = products.first(where: { $0.id == Self.productId }) else {
            throw ExportEntitlementError.productUnavailable
        }
        guard product.type == .nonConsumable else {
            throw ExportEntitlementError.invalidProductType
        }
        cachedProduct = product
        return product
    }

    private func hasCurrentEntitlement() async -> Bool {
        for await verification in Transaction.currentEntitlements {
            guard case .verified(let transaction) = verification else { continue }
            if isValidEntitlement(transaction) { return true }
        }
        return false
    }

    private func verifiedTransaction(
        from result: VerificationResult<Transaction>
    ) throws -> Transaction {
        switch result {
        case .verified(let transaction):
            return transaction
        case .unverified(_, let error):
            throw ExportEntitlementError.verificationFailed(error.localizedDescription)
        }
    }

    private func isValidEntitlement(_ transaction: Transaction) -> Bool {
        guard transaction.productID == Self.productId,
              transaction.productType == .nonConsumable,
              transaction.revocationDate == nil else {
            return false
        }
        if let expirationDate = transaction.expirationDate,
           expirationDate <= Date() {
            return false
        }
        return true
    }
}
