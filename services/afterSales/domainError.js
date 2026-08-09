class AfterSalesError extends Error {
  constructor(code,message,status=400,details=null){super(message);this.name='AfterSalesError';this.code=code;this.status=status;this.details=details}
}
function sendDomainError(res,error){if(!(error instanceof AfterSalesError))return false;res.status(error.status).json({message:error.message,code:error.code,details:error.details});return true}
module.exports={AfterSalesError,sendDomainError}
