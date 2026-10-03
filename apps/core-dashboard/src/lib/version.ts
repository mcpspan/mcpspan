import dashboardPackage from '../../package.json';

/**
 * This dashboard's version, fixed when the image is built.
 *
 * Imported rather than read from disk at runtime, because a build is the only
 * thing that can change it, and an import cannot go missing from an image the
 * way a file beside the server can.
 */
export const DASHBOARD_VERSION: string = dashboardPackage.version;
