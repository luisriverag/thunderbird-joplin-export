async function getSetting(name) {
  // Convenience wrapper to get a setting from local storage.
  return (await browser.storage.local.get(name))[name];
}

async function handleJoplinButton(tab, info) {
  // Check for joplin api token. If it isn't present, we can skip everything else.
  const apiToken = (await browser.storage.local.get("joplinToken")).joplinToken;
  if (!apiToken) {
    // https://github.com/thundernest/sample-extensions/tree/77f79f986e6005c07008d974fa629e258dcceb80/managedStorage
    throw new Error("API token not set. Please specify it at the settings.");
  }

  const baseUrl =
    (await browser.storage.local.get("joplinScheme")).joplinScheme +
    "://" +
    (await browser.storage.local.get("joplinHost")).joplinHost +
    ":" +
    (await browser.storage.local.get("joplinPort")).joplinPort;

  //////////////////////////////////////////////////
  // Mail content
  //////////////////////////////////////////////////

  // https://webextension-api.thunderbird.net/en/91/messages.html#messages-messageheader
  let tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  let mailHeader = await browser.messageDisplay.getDisplayedMessage(tabs[0].id);
  if (!mailHeader) {
    throw new Error("Mail header is empty");
  }

  // Body
  function getMailContent(mail, contentType, content = "") {
    if (mail.body && mail.contentType === contentType) {
      content += mail.body;
    }
    if (mail.parts) {
      for (let part of mail.parts) {
        content = getMailContent(part, contentType, content);
      }
    }
    return content;
  }

  const mailObject = await browser.messages.getFull(mailHeader.id);
  const contentType = await getSetting("joplinNoteFormat");

  // text/html and text/plain seem to be the only used MIME types for the body.
  const mailBodyHtml = getMailContent(mailObject, "text/html");
  const mailBodyPlain = getMailContent(mailObject, "text/plain");
  if (!mailBodyHtml && !mailBodyPlain) {
    throw new Error("Mail body is empty");
  }

  // Add a note with the email content
  url = `${baseUrl}/notes?fields=id,body&token=${apiToken}`;
  let data = {
    title: mailHeader.subject + " from " + mailHeader.author,
    parent_id: (await getSetting("joplinNoteParentFolder")) || "",
  };

  // If the preferred content type doesn't contain data, fall back to the other content type.
  if ((contentType === "text/html" && mailBodyHtml) || !mailBodyPlain) {
    console.log("Sending data in HTML format.");
    data["body_html"] = mailBodyHtml;
  }
  if ((contentType === "text/plain" && mailBodyPlain) || !mailBodyHtml) {
    console.log("Sending data in plain format.");
    data["body"] = mailBodyPlain;
  }

  // https://javascript.info/fetch
  response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const noteInfo = await response.json();

  //////////////////////////////////////////////////
  // Tags
  //////////////////////////////////////////////////

  // User specified tags are stored in a comma separated string.
  const userTagsString = await getSetting("joplinNoteTags");
  const userTags = userTagsString.split(",");

  for (tag of userTags.concat(mailHeader.tags)) {
    // Check whether tag exists already
    url = `${baseUrl}/search?query=${tag}&type=tag&token=${apiToken}`;
    data = { title: tag };
    response = await fetch(url);
    const searchResult = await response.json();
    const matchingTags = searchResult["items"];

    let tagId;
    if (matchingTags.length === 0) {
      // create new tag
      url = `${baseUrl}/tags?token=${apiToken}`;
      data = { title: tag };
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const tagInfo = await response.json();
      tagId = tagInfo["id"];
    } else if (matchingTags.length === 1) {
      // use id of the existing tag
      tagId = matchingTags[0]["id"];
    } else {
      throw new Error(`Too many matching tags "${matchingTags}" for "${tag}"`);
    }

    // attach tag to note
    url = `${baseUrl}/tags/${tagId}/notes?token=${apiToken}`;
    data = { id: noteInfo["id"] };
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  }

  //////////////////////////////////////////////////
  // Attachments
  //////////////////////////////////////////////////

  // https://webextension-api.thunderbird.net/en/latest/messages.html#getattachmentfile-messageid-partname
  const attachments = await browser.messages.listAttachments(mailHeader.id);
  let attachmentString = "\n\n**Attachments**: ";
  for (attachment of attachments) {
    const attachmentFile = await browser.messages.getAttachmentFile(
      mailHeader.id,
      attachment.partName
    );

    const formData = new FormData();
    formData.append("data", attachmentFile);
    formData.append("props", JSON.stringify({ title: attachment.name }));
    // https://joplinapp.org/api/references/rest_api/#post-resources
    url = `${baseUrl}/resources?token=${apiToken}`;
    response = await fetch(url, {
      method: "POST",
      body: formData,
    });
    const resourceInfo = await response.json();
    attachmentString += `\n[${attachment.name}](:/${resourceInfo["id"]})`;
  }

  // Always operate on body, even if previously used body_html.
  // TODO: Check is this has side effects.
  url = `${baseUrl}/notes/${noteInfo["id"]}?&token=${apiToken}`;
  response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: noteInfo["body"] + attachmentString }),
  });
  if (!response.ok) {
    console.log(await response.text());
  }
}

browser.messageDisplayAction.onClicked.addListener(handleJoplinButton);
