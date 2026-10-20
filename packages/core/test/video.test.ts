import { describe, expect, it } from "vitest";
import { markdownToGuide, videoEmbed, videoFromPaste, videoIframe } from "../src";

const yt = (path: string) => `https://www.youtube-nocookie.com/embed/${path}`;

describe("video links", () => {
  it("reads YouTube's link styles", () => {
    expect(videoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoEmbed("https://youtu.be/dQw4w9WgXcQ?si=abc123")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoEmbed("youtube.com/watch?v=dQw4w9WgXcQ&list=PLx&index=2")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoEmbed("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoEmbed("https://www.youtube.com/shorts/dQw4w9WgXcQ")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoEmbed("https://www.youtube.com/live/dQw4w9WgXcQ")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoEmbed("https://www.youtube.com/embed/dQw4w9WgXcQ?si=x")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoEmbed("//www.youtube-nocookie.com/embed/dQw4w9WgXcQ")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoEmbed("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI")?.src).toBe(yt("videoseries?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"));
    expect(videoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.title).toBe("YouTube video");
  });

  it("keeps a start time", () => {
    expect(videoEmbed("https://youtu.be/dQw4w9WgXcQ?t=90")?.src).toBe(yt("dQw4w9WgXcQ?start=90"));
    expect(videoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")?.src).toBe(yt("dQw4w9WgXcQ?start=90"));
    expect(videoEmbed("https://www.youtube.com/embed/dQw4w9WgXcQ?start=42")?.src).toBe(yt("dQw4w9WgXcQ?start=42"));
    expect(videoEmbed("https://vimeo.com/76979871#t=1m5s")?.src).toBe("https://player.vimeo.com/video/76979871?dnt=1#t=65s");
  });

  it("reads Vimeo's link styles, keeping an unlisted video's key", () => {
    expect(videoEmbed("https://vimeo.com/76979871")?.src).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(videoEmbed("https://vimeo.com/76979871/8272103f6e")?.src).toBe("https://player.vimeo.com/video/76979871?h=8272103f6e&dnt=1");
    expect(videoEmbed("https://player.vimeo.com/video/76979871?h=8272103f6e&badge=0&app_id=58479")?.src).toBe("https://player.vimeo.com/video/76979871?h=8272103f6e&dnt=1");
    expect(videoEmbed("https://vimeo.com/channels/staffpicks/76979871")?.src).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(videoEmbed("https://vimeo.com/showcase/11223344/video/76979871")?.src).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(videoEmbed("https://vimeo.com/groups/motion/videos/76979871")?.src).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(videoEmbed("https://vimeo.com/76979871")?.title).toBe("Vimeo video");
  });

  it("turns down everything else", () => {
    for (const link of [
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://evil.example/?u=https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ\"><script>",
      "https://www.youtube.com/@somechannel",
      "https://youtu.be/",
      "https://vimeo.com/channels/staffpicks",
      "https://vimeo.com/76979871abc",
      "javascript:alert(1)//youtu.be/dQw4w9WgXcQ",
      "ftp://youtu.be/dQw4w9WgXcQ",
      "",
    ])
      expect(videoEmbed(link), link).toBeNull();
    // Whatever was in the link, only a checked id and key reach the player's address.
    expect(videoEmbed('https://player.vimeo.com/video/76979871?h="onload=alert(1)')?.src).toBe("https://player.vimeo.com/video/76979871?dnt=1");
  });

  it("finds the video in a pasted link or embed code", () => {
    expect(videoFromPaste("  https://youtu.be/dQw4w9WgXcQ \n")?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(videoFromPaste('<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ?si=Ab" title="YouTube video player" frameborder="0" allowfullscreen></iframe>')?.src).toBe(yt("dQw4w9WgXcQ"));
    expect(
      videoFromPaste('<div style="padding:56.25% 0 0 0;position:relative;"><iframe src="https://player.vimeo.com/video/76979871?h=8272103f6e&amp;badge=0" frameborder="0"></iframe></div><script src="https://player.vimeo.com/api/player.js"></script>')?.src,
    ).toBe("https://player.vimeo.com/video/76979871?h=8272103f6e&dnt=1");
    expect(videoFromPaste("Watch https://youtu.be/dQw4w9WgXcQ first")).toBeNull();
    expect(videoFromPaste('<iframe src="https://example.com/embed/x"></iframe>')).toBeNull();
  });

  it("makes the player's HTML", () => {
    expect(videoIframe(videoEmbed("https://vimeo.com/76979871/8272103f6e")!)).toBe(
      '<iframe src="https://player.vimeo.com/video/76979871?h=8272103f6e&amp;dnt=1" title="Vimeo video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>',
    );
  });

  it("shows a video link alone on its line in an assistant's guide", () => {
    const { html, text } = markdownToGuide("Watch this first:\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nThen see https://vimeo.com/76979871 for more.\n\nhttps://example.com/not-a-video");
    expect(html).toBe(
      `<p>Watch this first:</p><p>${videoIframe(videoEmbed("https://youtu.be/dQw4w9WgXcQ")!)}</p>` +
        "<p>Then see https://vimeo.com/76979871 for more.</p><p>https://example.com/not-a-video</p>",
    );
    expect(text).toBe("Watch this first:\nThen see https://vimeo.com/76979871 for more.\nhttps://example.com/not-a-video");
  });
});
