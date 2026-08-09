class ClientRequestDomainError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message)
    this.name = 'ClientRequestDomainError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function sendDomainError(res, error) {
  if (!(error instanceof ClientRequestDomainError)) return false
  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
    message: error.message,
  })
  return true
}

module.exports = { ClientRequestDomainError, sendDomainError }
