class DispatchDeliveryError extends Error {
  constructor(code,message,status=400,details=null){super(message);this.name='DispatchDeliveryError';this.code=code;this.status=status;this.details=details}
}
function sendDomainError(res,error){if(!(error instanceof DispatchDeliveryError))return false;res.status(error.status).json({message:error.message,code:error.code,details:error.details});return true}
module.exports={DispatchDeliveryError,sendDomainError}
