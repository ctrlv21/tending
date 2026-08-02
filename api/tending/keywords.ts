import { keywords } from "../../tendings/server/keywords.js";

export default async function handler(request: Parameters<typeof keywords>[0], response: Parameters<typeof keywords>[1]) {
  return keywords(request, response);
}
