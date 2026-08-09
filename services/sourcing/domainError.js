class SourcingDomainError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message)
    this.name = 'SourcingDomainError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function sendDomainError(res, error) {
  if (!(error instanceof SourcingDomainError)) return false
  res.status(error.status).json({
    error: { code: error.code, message: error.message, details: error.details },
    message: error.message,
  })
  return true
}

module.exports = { SourcingDomainError, sendDomainError }
