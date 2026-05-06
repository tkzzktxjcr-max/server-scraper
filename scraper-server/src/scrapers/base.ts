// Set up API interception for detail page
        const detailApiResponses = await interceptResponses(puppeteerPage, this.getApiPattern());

        await puppeteerPage.goto(detailUrl, {