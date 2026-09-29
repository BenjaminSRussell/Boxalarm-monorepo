// Fail-closed fallback, deployed ONLY when backend/dist has no platform-service/authorizer
// bundle (lambdaCode warns). The real handler is backend platform-service/authorizer.
exports.handler = async (event) => {
  console.log(
    JSON.stringify({
      msg: "authorizer stub deny",
      hasAuth: Boolean(event.headers?.authorization || event.headers?.Authorization),
    }),
  );
  return { isAuthorized: false };
};
