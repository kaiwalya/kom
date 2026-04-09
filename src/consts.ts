// Hardcoded site-wide constants. Not environment-dependent.
// Edit these directly when the content changes.

export const SITE_NAME = 'Kaiwalya Kher';
export const SITE_DESCRIPTION = 'Personal website and blog of Kaiwalya Kher';

export const AUTHOR = {
  name: 'Kaiwalya Kher',
  givenName: 'Kaiwalya',
  familyName: 'Kher',
  jobTitle: 'Co-Founder & CTO at Joy',
} as const;

export const SOCIAL_LINKS = [
  { label: 'GitHub', href: 'https://github.com/kaiwalya' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/kaiwalya' },
  { label: 'Instagram', href: 'https://www.instagram.com/knkher' },
  { label: 'Flickr', href: 'https://www.flickr.com/photos/knkher' },
] as const;

export const NAV_ITEMS = [
  { label: 'home', href: '/' },
  { label: 'about', href: '/about/' },
  { label: 'resume', href: '/resume/' },
] as const;
