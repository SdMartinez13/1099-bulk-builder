(() => {
  const MAX_BYTES = 20 * 1024 * 1024;
  const ALLOWED_EXTENSIONS = new Set([
    "svg", "ai", "eps", "jpg", "jpeg", "bmp", "png", "heic", "tiff", "tif",
    "ppt", "pptx", "doc", "docx", "pdf", "psd",
  ]);
  const uploadedFiles = new WeakMap();

  const extensionOf = (name) => {
    const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  };

  const parseJson = async (response) => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  const uploadArtwork = async (file, slot) => {
    const cached = uploadedFiles.get(file);
    if (cached) return cached;

    const stageResponse = await fetch("/apps/1099-builder/engraving-stage", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        slot,
      }),
    });
    const stage = await parseJson(stageResponse);
    if (!stageResponse.ok || !stage?.ok) {
      throw new Error(stage?.error || "We couldn’t prepare that artwork upload.");
    }

    const uploadBody = new FormData();
    for (const parameter of stage.upload.parameters || []) {
      uploadBody.append(parameter.name, parameter.value);
    }
    uploadBody.append("file", file, file.name);

    const directUpload = await fetch(stage.upload.url, {
      method: stage.upload.method || "POST",
      body: uploadBody,
    });
    if (!directUpload.ok) {
      throw new Error("The artwork file could not be uploaded. Please reselect it and try again.");
    }

    const finalizeResponse = await fetch("/apps/1099-builder/engraving-finalize", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: stage.artwork.token }),
    });
    const finalized = await parseJson(finalizeResponse);
    if (!finalizeResponse.ok || !finalized?.ok || !finalized?.artwork?.url) {
      throw new Error(finalized?.error || "We couldn’t finalize that artwork upload.");
    }

    uploadedFiles.set(file, finalized.artwork);
    return finalized.artwork;
  };

  function init(root) {
    if (root.dataset.engravingInitialized === "1") return;
    root.dataset.engravingInitialized = "1";

    const section = root.closest(".shopify-section")
      || document.getElementById(`shopify-section-${root.dataset.sectionId}`)
      || root.parentElement;
    const form = section?.querySelector('form[action*="/cart/add"]')
      || document.querySelector('form[action*="/cart/add"]');
    const errorEl = root.querySelector("[data-engraving-error]");
    const statusEl = root.querySelector("[data-engraving-status]");
    const textInput = root.querySelector("[data-engraving-text]");
    const notesInput = root.querySelector("[data-engraving-notes]");
    const fileInputs = Array.from(root.querySelectorAll("[data-engraving-file]"));
    const slots = Array.from(root.querySelectorAll("[data-artwork-slot]"));
    const dialog = root.querySelector("[data-artwork-requirements-dialog]");
    const variantsNode = root.querySelector("[data-engraving-variants]");
    let variants = [];
    let activeSlotCount = 1;

    try {
      variants = JSON.parse(variantsNode?.textContent || "[]");
    } catch {
      variants = [];
    }

    const showError = (message) => {
      if (!errorEl) return;
      errorEl.textContent = message || "";
      errorEl.hidden = !message;
    };

    const setStatus = (message) => {
      if (statusEl) statusEl.textContent = message || "";
    };

    if (!form) {
      showError("This customization block could not connect to the product form. Please refresh the page or contact 1099 Designs.");
      return;
    }

    const selectedVariantTitle = () => {
      const idInput = form.querySelector('[name="id"]');
      const id = String(idInput?.value || "");
      return variants.find((variant) => String(variant.id) === id)?.title || "";
    };

    const updateArtworkSlots = () => {
      const multiDesign = /up to 4 different designs/i.test(selectedVariantTitle());
      activeSlotCount = multiDesign ? 4 : 1;

      slots.forEach((slotEl, index) => {
        const slotNumber = index + 1;
        const visible = slotNumber <= activeSlotCount;
        slotEl.hidden = !visible;
        const label = slotEl.querySelector("[data-artwork-slot-label]");
        if (label) label.textContent = multiDesign ? `Artwork ${slotNumber}` : "Artwork";
        if (!visible) {
          const input = slotEl.querySelector("[data-engraving-file]");
          if (input) input.value = "";
        }
      });
    };

    const validateFile = (file) => {
      if (!file) return "";
      if (file.size > MAX_BYTES) return `${file.name} is larger than 20 MB.`;
      if (!ALLOWED_EXTENSIONS.has(extensionOf(file.name))) {
        return `${file.name} is not an accepted artwork file type.`;
      }
      return "";
    };

    fileInputs.forEach((input) => {
      input.addEventListener("change", () => {
        showError("");
        const file = input.files?.[0];
        const help = input.closest("[data-artwork-slot]")?.querySelector("[data-file-help]");
        if (!file) {
          if (help) help.textContent = "SVG, AI, EPS, JPG, BMP, PNG, HEIC, TIFF, PPT, DOC, PDF, or PSD · 20 MB max";
          return;
        }

        const problem = validateFile(file);
        if (problem) {
          input.value = "";
          showError(problem);
          if (help) help.textContent = "Please choose another file.";
          return;
        }
        if (help) help.textContent = `Selected: ${file.name}`;
      });
    });

    root.querySelector("[data-artwork-requirements-open]")?.addEventListener("click", () => {
      if (!dialog) return;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    });

    root.querySelector("[data-artwork-requirements-close]")?.addEventListener("click", () => {
      if (!dialog) return;
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    });

    dialog?.addEventListener("click", (event) => {
      if (event.target === dialog && typeof dialog.close === "function") dialog.close();
    });

    const addProperty = (name, value) => {
      if (!value) return;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = `properties[${name}]`;
      input.value = value;
      input.className = "engraving-generated-property";
      form.appendChild(input);
    };

    const clearGeneratedProperties = () => {
      form.querySelectorAll(".engraving-generated-property").forEach((input) => input.remove());
    };

    const setButtonsDisabled = (disabled) => {
      form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach((button) => {
        button.disabled = disabled;
      });
    };

    form.addEventListener("change", () => window.setTimeout(updateArtworkSlots, 0));
    updateArtworkSlots();

    form.addEventListener("submit", async (event) => {
      if (root.dataset.engravingBypass === "1") {
        root.dataset.engravingBypass = "0";
        return;
      }

      updateArtworkSlots();
      showError("");
      setStatus("");

      const engravingText = String(textInput?.value || "").trim();
      const notes = String(notesInput?.value || "").trim();
      const activeInputs = fileInputs.slice(0, activeSlotCount);
      const selectedFiles = activeInputs
        .map((input, index) => ({ file: input.files?.[0] || null, slot: index + 1 }))
        .filter((item) => item.file);

      if (!engravingText && selectedFiles.length === 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        showError("Please enter engraving text, upload artwork, or use both.");
        root.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }

      for (const item of selectedFiles) {
        const problem = validateFile(item.file);
        if (problem) {
          event.preventDefault();
          event.stopImmediatePropagation();
          showError(problem);
          root.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      const submitter = event.submitter;
      setButtonsDisabled(true);

      try {
        let uploaded = [];
        if (selectedFiles.length) {
          setStatus(selectedFiles.length === 1 ? "Uploading artwork…" : `Uploading ${selectedFiles.length} artwork files…`);
          uploaded = await Promise.all(
            selectedFiles.map((item) => uploadArtwork(item.file, item.slot)),
          );
        }

        clearGeneratedProperties();
        addProperty("Engraving Text", engravingText);
        addProperty("Engraving Notes", notes);
        addProperty("Proof", "Digital proof required before production");

        uploaded.forEach((artwork, index) => {
          const displayNumber = activeSlotCount > 1 ? ` ${index + 1}` : "";
          addProperty(`Artwork${displayNumber}`, artwork.filename);
          addProperty(`_Artwork${displayNumber} URL`, artwork.url);
          addProperty(`_Artwork${displayNumber} File ID`, artwork.id);
        });

        setStatus("Artwork attached. Adding your customized item to cart…");
        root.dataset.engravingBypass = "1";
        setButtonsDisabled(false);

        if (typeof form.requestSubmit === "function") {
          const validSubmitter = submitter && submitter.form === form && !submitter.disabled ? submitter : undefined;
          form.requestSubmit(validSubmitter);
        } else {
          form.submit();
        }
      } catch (error) {
        root.dataset.engravingBypass = "0";
        setButtonsDisabled(false);
        setStatus("");
        showError(error instanceof Error ? error.message : "We couldn’t attach your artwork. Please try again.");
        root.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, true);
  }

  const initAll = (scope = document) => {
    scope.querySelectorAll?.("[data-engraving-personalization]").forEach(init);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initAll());
  } else {
    initAll();
  }

  document.addEventListener("shopify:section:load", (event) => initAll(event.target));
})();
