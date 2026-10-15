"""
Klein Canny Reference - Forge Neo extension

Gives Flux.2 Klein (4B / 9B) a "ControlNet-like" structure guide:
an uploaded template image is turned into a Canny edge map and passed to
the model as a native reference latent (the same mechanism ComfyUI uses
with its ReferenceLatent node). The prompt is extended with an instruction
telling Klein to follow the edges of that reference.
"""

import gradio as gr
import numpy as np
import torch
from PIL import Image

from backend.args import dynamic_args
from modules import images, scripts, shared
from modules.processing import StableDiffusionProcessing, StableDiffusionProcessingImg2Img
from modules.sd_samplers_common import images_tensor_to_samples
from modules.shared import device, opts
from modules.ui_components import FormRow, InputAccordion

TAG = "[KleinCanny]"
print(f"{TAG} extension loaded ({__file__})")

MODES = ["Canny", "Canny + Original", "Original (no preprocessing)"]

DEFAULT_INSTRUCTION = (
    "Use image {n} as a canny edge map: follow its outlines, composition, "
    "pose and proportions exactly, but render a fully detailed image without visible lines."
)

INFO = """
<b>Flux.2 Klein</b> (4B / 9B): Upload a template image. It is converted into a Canny edge map
and passed to Klein as a <b>reference image</b> - comparable to a Canny ControlNet.<br>
Works in <b>txt2img</b> (recommended) and <b>img2img</b>. <code>[Klein] Enable Reference</code>
is switched on automatically for this generation.
"""


def _to_rgb(img: Image.Image) -> Image.Image:
    if img.mode == "RGB":
        return img
    return images.flatten(img, opts.img2img_background_color).convert("RGB")


def _fit(img: Image.Image, limit: int) -> Image.Image:
    """Resize to max side `limit` (0 = no limit) and snap to multiples of 64."""
    w, h = img.size
    if limit > 0 and max(w, h) > limit:
        ratio = limit / max(w, h)
        w, h = int(w * ratio), int(h * ratio)
    w, h = max(64, round(w / 64) * 64), max(64, round(h / 64) * 64)
    if (w, h) != img.size:
        img = images.resize_image(1, img, w, h)
    return img


def make_canny(img: Image.Image, low: int, high: int, blur: int, invert: bool) -> Image.Image:
    import cv2  # bundled with Forge Neo (opencv-python)

    gray = cv2.cvtColor(np.array(_to_rgb(img)), cv2.COLOR_RGB2GRAY)
    if blur > 0:
        k = blur * 2 + 1
        gray = cv2.GaussianBlur(gray, (k, k), 0)
    edges = cv2.Canny(gray, int(low), int(high))
    if invert:
        edges = 255 - edges
    return Image.fromarray(cv2.cvtColor(edges, cv2.COLOR_GRAY2RGB))


def build_references(img, mode, low, high, blur, invert, max_dim) -> list[Image.Image]:
    base = _fit(_to_rgb(img), int(max_dim))
    if mode == "Original (no preprocessing)":
        return [base]
    canny = make_canny(base, low, high, blur, invert)
    if mode == "Canny + Original":
        return [canny, base]
    return [canny]


class KleinCannyReference(scripts.Script):
    # run after the built-in ImageStitch (529) so its reset does not wipe our latents
    sorting_priority = 530

    # latents appended by this script, removed again in postprocess
    _own_latents: list[torch.Tensor] = []
    _saved_do_reference = None

    def title(self):
        return "Klein Canny Reference"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        with InputAccordion(value=False, label=self.title()) as enable:
            gr.HTML(INFO)
            with FormRow():
                template = gr.Image(
                    label="Template image",
                    type="pil",
                    sources=["upload", "clipboard"],
                    height=300,
                    show_download_button=False,
                    show_share_button=False,
                )
                preview = gr.Image(
                    label="Preprocessor preview",
                    type="pil",
                    interactive=False,
                    height=300,
                    show_share_button=False,
                )

            mode = gr.Radio(MODES, value=MODES[0], label="Mode", info="'Canny + Original' also passes the colors/content of the template")

            with FormRow():
                low = gr.Slider(1, 255, value=100, step=1, label="Canny low threshold")
                high = gr.Slider(1, 255, value=200, step=1, label="Canny high threshold")

            with FormRow():
                blur = gr.Slider(0, 5, value=1, step=1, label="Blur before Canny", info="reduces noise / fine texture")
                invert = gr.Checkbox(False, label="Invert (black lines on white)")

            with FormRow():
                match_size = gr.Checkbox(True, label="Match output size to template", info="txt2img: width/height follow the template aspect ratio")
                max_dim = gr.Slider(256, 2048, value=1024, step=64, label="Reference max side (px)", info="also used as output size when 'match' is on")

            add_instruction = gr.Checkbox(True, label="Append instruction to prompt")
            instruction = gr.Textbox(
                value=DEFAULT_INSTRUCTION,
                lines=2,
                label="Instruction",
                info="{n} is replaced by the number of the reference image (image 1, image 2, ...)",
            )

            btn_preview = gr.Button("Show preview", variant="secondary")

        def _preview(img, mode, low, high, blur, invert, max_dim):
            if img is None:
                return None
            return build_references(img, mode, low, high, blur, invert, max_dim)[0]

        preview_inputs = [template, mode, low, high, blur, invert, max_dim]
        btn_preview.click(fn=_preview, inputs=preview_inputs, outputs=[preview], queue=False, show_progress=False)
        template.upload(fn=_preview, inputs=preview_inputs, outputs=[preview], queue=False, show_progress=False)

        return [enable, template, mode, low, high, blur, invert, match_size, max_dim, add_instruction, instruction]

    # ------------------------------------------------------------------ #

    @classmethod
    def _remove_own_latents(cls, sd_model):
        if not cls._own_latents:
            return
        refs = getattr(sd_model, "ref_latents", None)
        if refs is not None:
            own = {id(t) for t in cls._own_latents}
            refs[:] = [t for t in refs if id(t) not in own]
        cls._own_latents = []

    @classmethod
    def _restore_option(cls):
        if cls._saved_do_reference is not None:
            opts.klein_do_reference = cls._saved_do_reference
            cls._saved_do_reference = None

    def process(self, p: StableDiffusionProcessing, enable, template, mode, low, high, blur, invert, match_size, max_dim, add_instruction, instruction):
        self._remove_own_latents(p.sd_model)
        self._restore_option()

        if not enable:
            return
        if template is None:
            print(f"{TAG} enabled but no template image - skipped")
            return
        if not dynamic_args.can_reference():
            print(f"{TAG} current model does not support reference images (needs Flux.2 Klein) - skipped")
            return
        if not dynamic_args.klein:
            print(f"{TAG} model is not Flux.2 Klein - trying anyway (Kontext / Qwen-Edit may behave differently)")

        if dynamic_args.klein and not opts.klein_do_reference:
            try:
                opts.klein_do_reference = True
                KleinCannyReference._saved_do_reference = False
            except Exception as e:
                print(f"{TAG} could not enable '[Klein] Enable Reference' ({e}) - please enable it in Settings")
                return

        refs = build_references(template, mode, low, high, blur, invert, max_dim)

        is_img2img = isinstance(p, StableDiffusionProcessingImg2Img)
        if match_size and not is_img2img:
            p.width, p.height = refs[0].size

        # Number of the first reference image as Klein sees it:
        # img2img init image (if any) is image 1, then existing refs (ImageStitch), then ours.
        existing = len(getattr(p.sd_model, "ref_latents", []))
        first_index = existing + 1 + (1 if is_img2img else 0)

        before = list(p.sd_model.ref_latents)
        dynamic_args.is_referencing = True
        try:
            for ref in refs:
                arr = np.moveaxis(np.array(ref, dtype=np.float32) / 255.0, 2, 0)
                tensor = torch.from_numpy(arr).to(device=device).unsqueeze(0)
                images_tensor_to_samples(tensor, 0, p.sd_model)  # -> encode_first_stage -> ref_latents
        finally:
            dynamic_args.is_referencing = False

        before_ids = {id(t) for t in before}
        KleinCannyReference._own_latents = [t for t in p.sd_model.ref_latents if id(t) not in before_ids]
        p.clear_prompt_cache()  # force re-encoding so the new references are picked up

        if add_instruction and instruction.strip() and mode != "Original (no preprocessing)":
            text = instruction.replace("{n}", str(first_index)).strip()

            def _append(prompts):
                return [f"{pr.rstrip().rstrip(',')}. {text}" if pr.strip() else text for pr in prompts]

            p.all_prompts = _append(p.all_prompts)
            if getattr(p, "all_hr_prompts", None):
                p.all_hr_prompts = _append(p.all_hr_prompts)

        p.extra_generation_params["Klein Canny"] = f"{mode}, {int(low)}/{int(high)}, blur {int(blur)}" + (", inverted" if invert else "")
        print(f"{TAG} encoded {len(KleinCannyReference._own_latents)} reference(s) ({refs[0].size[0]}x{refs[0].size[1]}), first = image {first_index}")

    def postprocess(self, p, processed, *args):
        if self._own_latents:
            self._remove_own_latents(p.sd_model)
            p.clear_prompt_cache()
        self._restore_option()
        if hasattr(shared.sd_model, "ref_latents") and not shared.sd_model.ref_latents:
            dynamic_args.ref_latents.clear()
