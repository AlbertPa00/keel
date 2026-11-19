export const run = (code: string) => JSON.parse(code);

// Field names and descriptions are not credentials — these must NOT trip:
const errors = { password: "Password is required for human accounts." };
const schema = { secret: "Webhook secret", api_key: "Your API key" };
export const check = (data: { password?: string }) => data.password !== undefined;
export const env = () => process.env.ACCESS_TOKEN;
