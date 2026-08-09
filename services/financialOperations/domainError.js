class FinancialOperationsError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

const sendDomainError = (res, error) => {
  if (!(error instanceof FinancialOperationsError)) return false
  res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } })
  return true
}

module.exports = { FinancialOperationsError, sendDomainError }
