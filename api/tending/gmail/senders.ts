import { gmailSenders } from "../../../tendings/server/gmail.js";

export default async function handler(request: Parameters<typeof gmailSenders>[0], response: Parameters<typeof gmailSenders>[1]) {
  return gmailSenders(request, response);
}
