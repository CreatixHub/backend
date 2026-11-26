import "dotenv/config";

console.log("folder:", process.cwd());
console.log("SCHOOL_UPI_ID:", JSON.stringify(process.env.SCHOOL_UPI_ID));
console.log("SCHOOL_PAYEE_NAME:", JSON.stringify(process.env.SCHOOL_PAYEE_NAME));