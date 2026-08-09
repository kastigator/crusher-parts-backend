class WarehouseInventoryError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function sendDomainError(res, error) {
  if (!(error instanceof WarehouseInventoryError)) return false
  res.status(error.status).json({ code: error.code, message: error.message })
  return true
}

module.exports = { WarehouseInventoryError, sendDomainError }
