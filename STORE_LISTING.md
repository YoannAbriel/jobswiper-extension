# Chrome Web Store Listing

## Name
JobSwiper — AI Job Prep

## Summary (max 132 chars)
Save jobs from Indeed, LinkedIn & more. Generate tailored CVs, cover letters & interview prep with AI — all in one click.

## Detailed Description
JobSwiper turns your job browsing into action. Save any job posting with one click, and let AI prepare everything you need to land the interview.

How it works:
Browse jobs on your favorite job boards. Click "Save to JobSwiper" on any listing. Get an instant match score based on your profile. Generate a tailored CV, cover letter, and interview prep — all powered by AI.

Supported job boards:
Indeed (all countries), LinkedIn, Welcome to the Jungle, Jobup.ch / Jobs.ch, Glassdoor, and ATS platforms like Greenhouse, Lever, Workday and more.

Key features:
One-click save from any supported job board. Instant match score showing how well you fit the role. AI-generated CVs tailored to each job posting. Cover letter generation in seconds. Interview preparation notes and simulation. Kanban pipeline to track your applications. Works across multiple languages and countries.

Your data, your control:
We only access job posting data when you click Save. Your auth token is stored locally in your browser. No browsing history is collected or tracked. Full privacy policy at https://www.jobswiper.ai/privacy

Get started free at https://www.jobswiper.ai

## Category
Productivity

## Language
English

## Developer Website
https://www.jobswiper.ai

## Support URL
https://www.jobswiper.ai/about

## Privacy Policy URL
https://www.jobswiper.ai/privacy

---

## Permission Justifications

| Permission | Justification |
|-----------|---------------|
| `activeTab` | To read job posting content (title, company, description) from the current page when the user clicks "Save to JobSwiper" |
| `storage` | To store the user's authentication token locally so they stay logged in across browsing sessions |
| `tabs` | To detect if JobSwiper is open in another tab for automatic authentication (auto-connect) |
| `scripting` | To inject the "Save to JobSwiper" button into job board pages and to read auth tokens from open JobSwiper tabs |
| `alarms` | To schedule reminder notifications (e.g., "You saved this job 3 days ago — ready to apply?") |
| `notifications` | To display job application reminders to the user |

## Host Permission Justifications

| Host | Justification |
|------|---------------|
| `indeed.com` (+ regional) | Inject save button and extract job data from Indeed job listings |
| `linkedin.com` | Inject save button and extract job data from LinkedIn job listings |
| `welcometothejungle.com` | Inject save button and extract job data from WTTJ job listings |
| `jobup.ch` / `jobs.ch` | Inject save button and extract job data from Swiss job board listings |
| `glassdoor.com` (+ regional) | Inject save button and extract job data from Glassdoor listings |
| `jobswiper.ai` | Detect extension installation and transfer auth tokens between the web app and extension |
| ATS platforms (greenhouse.io, lever.co, etc.) | Auto-fill job application forms with user profile data |
