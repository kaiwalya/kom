// Hardcoded site-wide constants. Not environment-dependent.
// Edit these directly when the content changes.

export const SITE_NAME = 'Kaiwalya Kher';
export const SITE_DESCRIPTION = 'Personal website and blog of Kaiwalya Kher';

export const AUTHOR = {
  name: 'Kaiwalya Kher',
  givenName: 'Kaiwalya',
  familyName: 'Kher',
  jobTitle: 'Computer Scientist',
} as const;

export const SOCIAL_LINKS = [
  { label: 'GitHub', href: 'https://github.com/kaiwalya' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/kaiwalya' },
  { label: 'Flickr', href: 'https://www.flickr.com/photos/knkher' },
] as const;

export const NAV_ITEMS = [
  { label: 'blog', href: '/' },
  { label: 'about', href: '/about/' },
  { label: 'resume', href: '/resume/' },
] as const;
