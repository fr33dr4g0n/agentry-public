export default {
  fetch(req: Request): Response {
    const url = new URL(req.url);
    url.hostname = "agentry.sh";
    url.protocol = "https:";
    url.port = "";
    return Response.redirect(url.toString(), 301);
  },
};
